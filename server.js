const express = require("express");
const path = require("path");
require("dotenv").config();
const multer = require("multer");
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");

const app = express();
const PORT = process.env.PORT || 3000;
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);

/**
 * Uploads the given file to Gemini.
 *
 * See https://ai.google.dev/gemini-api/docs/prompting_with_media
 */
async function uploadToGemini(path, mimeType) {
  const uploadResult = await fileManager.uploadFile(path, {
    mimeType,
    displayName: path,
  });
  const file = uploadResult.file;
  console.log(`Uploaded file ${file.displayName} as: ${file.name}`);
  return file;
}
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: `You are a form extraction agent. Extract form fields from the image into a JSON object with this exact structure:

{
  "metadata": {
    "title": string, // Title of the form
    "description": string // Description of the form
  },
  "items": [
    {
      "type": string,         // TEXT, CHECKBOX, DROPDOWN, MULTIPLE_CHOICE,
      "title": string,        // Field label/question
      "helpText": string,     // Additional instructions if any
      "isRequired": boolean,
      "choices": string[],    // For CHECKBOX/multiple choice fields
    }
  ],
}

Preserve the exact order of fields as shown in the image. Include all visible field attributes like required status, help text, and options for multiple choice questions.`,
});

const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

async function run(filePath, mimeType) {
  const files = [await uploadToGemini(filePath, mimeType)];

  const chatSession = model.startChat({
    generationConfig,
    history: [
      {
        role: "user",
        parts: [
          {
            fileData: {
              mimeType: files[0].mimeType,
              fileUri: files[0].uri,
            },
          },
        ],
      },
    ],
  });

  const result = await chatSession.sendMessage("Here is the image.");
  console.log("result.response.text()", result.response.text());
  return JSON.parse(result.response.text().replace(/```json|```/g, ''));
}
// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the "public" folder
app.use(express.static(path.join(__dirname, "public")));

async function createElevenLabsAgent(formDataJson, googleFormUrl, req) {
  const data_collection_config = {}
  const form_items = formDataJson.items
  form_items.forEach(item => {
    data_collection_config[item.title] = {
      type: "string",
      description:  `Give the exact response from the user for "${item.title}". 
- If there were options in the form, mention the exact response from the options available in the form fields other wise only the response from the user. 
- Don't use any filler words. 
- For email, give the exact email address i.e. example@example.com if you see in the form example at the rate example.com.
- For dates use DD/MM/YYYY format. 
- For phone numbers, give the exact phone number. 
- In case of number fields, give the exact value in number format.`,
    }
  })

  const elevenLabsUrl = "https://api.elevenlabs.io/v1/convai/agents/create";
  const agentResponse = await fetch(elevenLabsUrl, {
    method: "POST", 
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      name: formDataJson.metadata.title,
      conversation_config: {
        agent: {
          prompt: {
            prompt: `You are a survey agent. You have to ask the questions to the user for the below fields. Don't overwhelm the user and ask each question correctly according to their type. Also, stick to only survey questions, don't let the conversation go in any other direction. In case of options or choices, always state each and every option. Speak a little about what the form is about from the description in the start. When all the details are filled, end the call with the end_call action.
\n${JSON.stringify(formDataJson, null, 2)}`,
            llm: "gemini-1.5-flash",
            temperature: 0.5,
            max_tokens: -1,
            tools: [{type: "system", name: "end_call", description: "Ends the call"}],
            tool_ids: ["7H1TDc5dV3Su9duUsj9G"],
          },
          first_message: `Hey, ${formDataJson.metadata.title} form is all set - we'll keep it short and sweet. Shall we start?`,
          language: "en",
        },
        asr: {
          quality: "high",
          provider: "elevenlabs", 
          user_input_audio_format: "pcm_16000",
        },
        turn: {
          turn_timeout: 7,
          mode: "turn",
        },
        tts: {
          model_id: "eleven_flash_v2",
          voice_id: "cjVigY5qzO86Huf0OWal",
          agent_output_audio_format: "pcm_16000",
          optimize_streaming_latency: 3,
          stability: 0.5,
          similarity_boost: 0.8,
        },
        conversation: {
          max_duration_seconds: 300,
          client_events: ["audio", "interruption", "user_transcript", "agent_response", "agent_response_correction"],
        },
      },
      platform_settings: {
        widget: {
          variant: "compact",
          expandable: "always", 
          avatar: {
            type: "orb",
            color_1: "#2b526f",
            color_2: "#000000",
          },
          action_text: "Eleven forms",
          start_call_text: "Click here to fill form",
          shareable_page_text: "Call the AI Agent to fill the form.",
        },
        data_collection: data_collection_config,
        privacy: {
          record_voice: true,
          retention_days: 730,
          delete_transcript_and_pii: true,
          delete_audio: true,
        },
      },
      secrets: [{
        secret_id: "GOOGLE_FORM_URL",
        name: googleFormUrl,
      }],
    }),
  });

  if (!agentResponse.ok) {
    const errorData = await agentResponse.text();
    throw new Error(`Failed to create agent: ${errorData}`);
  }

  const agentData = await agentResponse.json();
  const agentId = agentData.agent_id;

  return {
    agentId,
    surveyUrl: `${req.protocol}://${req.get("host")}/survey.html?agentId=${agentId}`,
    formDataJson,
  };
}

// API endpoint to create a form using uploaded image
app.post("/api/createFormFromImage", upload.single("image"), async (req, res) => {
  const image = req.file;
  console.log("image file:", image);
  const formDataJson = await run(image.path, image.mimetype);
  console.log("formDataJson", formDataJson);

  try {
    const result = await createElevenLabsAgent(formDataJson, "", req);
    res.json(result);
  } catch (error) {
    console.error("Error creating agent:", error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to create a conversational form
app.post("/api/createForm", async (req, res) => {
  const { googleFormUrl } = req.body;
  if (!googleFormUrl) {
    return res.status(400).json({ error: "googleFormUrl is required" });
  }

  try {
    const googleScriptUrl = `${process.env.GOOGLE_SCRIPT_ENDPOINT}?url=${encodeURIComponent(googleFormUrl)}`;
    const formResponse = await fetch(googleScriptUrl);
    if (!formResponse.ok) {
      throw new Error("Failed to fetch form data");
    }

    const formDataJson = await formResponse.text().then((text) => JSON.parse(text));
    const result = await createElevenLabsAgent(formDataJson, googleFormUrl, req);
    res.json(result);
  } catch (error) {
    console.error("Error in /api/createForm:", error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to fetch conversation history
app.get("/api/history/:agentId", async (req, res) => {
  const { agentId } = req.params;
  if (!agentId) {
    return res.status(400).json({ error: "agentId is required" });
  }
  try {
    // Fetch list of conversations
    const historyUrl = `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}`;
    const historyResponse = await fetch(historyUrl, {
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
      },
    });

    if (!historyResponse.ok) {
      const errorText = await historyResponse.text();
      throw new Error(`Failed to fetch history: ${errorText}`);
    }

    const historyData = await historyResponse.json();

    // Fetch details for each conversation
    const conversationsWithDetails = await Promise.all(
      historyData.conversations.map(async (conv) => {
        const detailUrl = `https://api.elevenlabs.io/v1/convai/conversations/${conv.conversation_id}`;
        const detailResponse = await fetch(detailUrl, {
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
          },
        });

        if (!detailResponse.ok) {
          console.warn(
            `Failed to fetch details for conversation ${conv.conversation_id}`
          );
          return conv;
        }

        const details = await detailResponse.json();
        return { ...conv, details };
      })
    );

    res.json({
      ...historyData,
      conversations: conversationsWithDetails,
    });
  } catch (error) {
    console.error("Error in /api/history:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/key", (req, res) => {
  res.send(process.env.ELEVENLABS_API_KEY);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
