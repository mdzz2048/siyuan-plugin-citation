// @ts-nocheck 
/* eslint-disable */
var item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);

// 获得notes
for (let noteID of noteIDs) {
  var noteItem = Zotero.Items.get(noteID);
  notes.push({
    note: noteItem.getNote(),
    ...getAllFields(noteItem),
    key: noteItem.key,
    itemType: noteItem.itemType
  });
}

// 输出结果
return JSON.stringify(notes);