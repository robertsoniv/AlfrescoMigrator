const express = require('express')
const AlfrescoApi = require('alfresco-js-api-node')
const _ = require('lodash')
const q = require('q');
const alfresco = new AlfrescoApi({
    hostEcm: 'https://content.bachmans.com'
});
const app = express()
const port = 3000

const alfrescoNodes = {
    documentLibrary: '0a67089c-ff35-486e-9a74-fe24165366fd',
    categories: 'f3a2ae73-4727-40b8-8994-a6c7dc8ac094'
}

function processCategories(nodeChildren, folderCache) {
    let queue = [];
    _.forEach(_.filter(nodeChildren.list.entries, (obj) => {
        return obj.entry.isFolder
    }), (categoryFolder) => {
        // console.log('Processing category ' + categoryFolder.entry.name + '...');
        queue.push(processCategoryFolder(categoryFolder.entry, folderCache))
    });
    return q.all(queue);
}

function processCategoryFolder(folder, folderCache) {
    let defer = q.defer();
    if (!folderCache) folderCache = [];
    folderCache.push(folder);
    alfresco.nodes.getNodeChildren(folder.id)
        .then((data) => {
            var queue = [];
            queue.push(processCategories(data, folderCache));
            queue.push(processCategoryFiles(data, folderCache, folder));
            q.all(queue)
                .then((results) => {
                    defer.resolve(results);
                })
        })
        .catch((ex) => {
            console.log(ex);
        })
    return defer.promise;
}

function processCategoryFiles(nodeChildren, folderCache, folder) {
    var defer = q.defer();
    var files = _.map(_.filter(nodeChildren.list.entries, (obj) => {
        return obj.entry.isFile && obj.entry.content.mimeType === 'image/jpeg';
    }), (file) => {
        if (file.entry.name.indexOf('ASpot') > -1) return;
        return mapCatImage(file.entry);
    });
    defer.resolve(_.compact(files));
    return defer.promise;
}

// mapASpot(file.entry, folderCache, folder);

function mapASpot(file, cache, folder) {
    var folderName = getFolderName(folder.parentId, cache, file.name);
    return {
        fields: {
            title: {
                "en-US": folderName
            },
            description: {
                "en-US": "category-banner-img"
            },
            file: {
                "en-US": {
                    "url": alfresco.content.getContentUrl(file.id),
                    "fileName": folderName,
                    "contentType": file.content.mimeType,
                    "details": {
                        size: file.content.sizeInBytes
                    }
                }
            }
        }
    }
}

function getFolderName(id, cache, origName) {
    if (alfrescoNodes.categories === id) return origName;
    var parent = _.find(cache, {
        id: id
    });
    if (!parent) return origName;
    return getFolderName(parent.parentId, cache, (parent.name === 'Media' ? '' : parent.name + '_') + origName);
}

function mapCatImage(file) {
    // console.log(file);
    return {
        fields: {
            title: {
                "en-US": file.name
            },
            description: {
                "en-US": "category-list-img"
            },
            file: {
                "en-US": {
                    "url": alfresco.content.getContentUrl(file.id),
                    "fileName": file.name,
                    "contentType": file.content.mimeType,
                    "details": {
                        size: file.content.sizeInBytes
                    }
                }
            }
        }
    }
}
app.get('/alfresco_export.json', (req, res) => {
    alfresco.nodes.getNodeChildren(alfrescoNodes.categories)
        .then(processCategories)
        .then((data) => res.send({
            assets: _.flatMapDeep(data).slice(0, 10)
        }))
        .catch((ex) => console.log(ex))
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}!`);
    console.log('Logging into Alfresco...');
    alfresco.login('admin', 'R1v3tatbachmans')
        .then(data => console.log('Login successful:', data))
        .catch(ex => console.log('Login failed:', ex))
})