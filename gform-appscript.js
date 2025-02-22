function doGet(e) {
  var formUrl = e.parameter.url;
  if (!formUrl) {
    return ContentService.createTextOutput("Please provide a form URL as a parameter 'url'.");
  }
  try {
    var form = FormApp.openByUrl(formUrl);
    var metadata = getFormMetadata(form);
    var items = form.getItems();
    var itemsMaps = items.map(itemToObject);
    var result = {
      "metadata": metadata,
      "items": itemsMaps,
      "count": items.length
    };
    return ContentService.createTextOutput(JSON.stringify(result))
                         .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput("Error: " + error)
                         .setMimeType(ContentService.MimeType.TEXT);
  }
}


function main() {
 var URL = "https://docs.google.com/forms/d/1eFEOqxB3yDsY2-9OUrJSA94XonF65GVknXD08ttHDpk/edit";

  var form = FormApp.openByUrl(URL);
  var items = form.getItems();

  var metadata = getFormMetadata(form);
  var itemsMaps = items.map(itemToObject)

  var result = {
    "metadata": metadata,
    "items": itemsMaps,
    "count": items.length
  };
  
  Logger.log(JSON.stringify(result));
}

/**
 * Returns the form metadata object for the given Form object.
 * @param form: Form
 * @returns (Object) object of form metadata.
 */
function getFormMetadata(form) {
  return {
    "title": form.getTitle(),
    "id": form.getId(),
    "description": form.getDescription(),
    "publishedUrl": form.getPublishedUrl(),
    "editorEmails": form.getEditors().map(function(user) {return user.getEmail()}),
    "count": form.getItems().length,
    "confirmationMessage": form.getConfirmationMessage(),
    "customClosedFormMessage": form.getCustomClosedFormMessage()
  };
}

/**
 * Returns an Object for a given Item.
 * @param item: Item
 * @returns (Object) object for the given item.
 */
function itemToObject(item) {
  var data = {};
  
  data.type = item.getType().toString();
  data.title = item.getTitle();
  
  // Downcast items to access type-specific properties
  
  var itemTypeConstructorName = snakeCaseToCamelCase("AS_" + item.getType().toString() + "_ITEM");  
  var typedItem = item[itemTypeConstructorName]();
  
  // Keys with a prefix of "get" have "get" stripped
  
  var getKeysRaw = Object.keys(typedItem).filter(function(s) {return s.indexOf("get") == 0});
  getKeysRaw.map(function(getKey) {    
    var propName = getKey[3].toLowerCase() + getKey.substr(4);
    
    // Image data, choices, and type come in the form of objects / enums
    if (["image", "choices", "type", "alignment"].indexOf(propName) != -1) {return};
    
    // Skip feedback-related keys
    if ("getFeedbackForIncorrect" === getKey || "getFeedbackForCorrect" === getKey
      || "getGeneralFeedback" === getKey) {return};
    
    var propValue = typedItem[getKey]();
    
    data[propName] = propValue;
  });
  
  // Bool keys are included as-is
  
  var boolKeys = Object.keys(typedItem).filter(function(s) {
    return (s.indexOf("is") == 0) || (s.indexOf("has") == 0) || (s.indexOf("includes") == 0);
  });
  
  boolKeys.map(function(boolKey) {
    var propName = boolKey;
    var propValue = typedItem[boolKey]();
    data[propName] = propValue;
  });
  
  // Handle image data and list choices
  
  switch (item.getType()) {
    case FormApp.ItemType.LIST:
    case FormApp.ItemType.CHECKBOX:
    case FormApp.ItemType.MULTIPLE_CHOICE:
      data.choices = typedItem.getChoices().map(function(choice) {
        return choice.getValue();
      });
      break;
    
    case FormApp.ItemType.IMAGE:
      data.alignment = typedItem.getAlignment().toString();
      
      if (item.getType() == FormApp.ItemType.VIDEO) {
        return;
      }
      
      var imageBlob = typedItem.getImage();
      
      data.imageBlob = {
        "dataAsString": imageBlob.getDataAsString(),
        "name": imageBlob.getName(),
        "isGoogleType": imageBlob.isGoogleType()
      };
      
      break;
      
    case FormApp.ItemType.PAGE_BREAK:
      data.pageNavigationType = typedItem.getPageNavigationType().toString();
      break;
      
    default:
      break;
  }
  
  // Have to do this because for some reason Google Scripts API doesn't have a
  // native VIDEO type
  if (item.getType().toString() === "VIDEO") {
    data.alignment = typedItem.getAlignment().toString();
  }
  
  return data;
}

function snakeCaseToCamelCase(s) {
  return s.toLowerCase().replace(/(\_\w)/g, function(m) {return m[1].toUpperCase();});
}