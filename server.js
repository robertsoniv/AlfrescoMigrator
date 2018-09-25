const express = require('express')
const AlfrescoApi = require('alfresco-js-api-node')
const OrderCloud = require('ordercloud-javascript-sdk')
const _ = require('lodash')
const q = require('q')
const fs = require('fs')
const uuid = require('uuid/v4')
const {
    exec
} = require('child_process')
const alfresco = new AlfrescoApi({
    hostEcm: 'https://content.bachmans.com'
});
const app = express()
app.set('json spaces', 2);
const port = 3000
let contentfulExportData;

const alfrescoNodes = {
    documentLibrary: '0a67089c-ff35-486e-9a74-fe24165366fd',
    categories: 'f3a2ae73-4727-40b8-8994-a6c7dc8ac094',
    products: '40ad56b2-497d-4552-a5e2-a2eede661ca3'
}

function processCategories(nodeChildren, folderCache) {
    let queue = [];
    _.forEach(_.filter(nodeChildren.list.entries, (obj) => {
        return obj.entry.isFolder
    }), (categoryFolder) => {
        // console.log('Processing category ' + categoryFolder.entry.name + '...');
        queue.push(processCategoryFolder(categoryFolder.entry, folderCache))
    });
    return q.all(queue)
        .then(results => {
            return _.flatMapDeep(results);
        })
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
    var files = _.compact(_.map(_.filter(nodeChildren.list.entries, (obj) => {
        return obj.entry.isFile && obj.entry.content.mimeType === 'image/jpeg';
    }), (file) => {
        if (file.entry.name.indexOf('ASpot') > -1) return mapASpot(file.entry, folderCache, folder);
        return mapCatImage(file.entry);
    }));
    defer.resolve(files);
    return defer.promise;
}

function mapASpot(file, cache, folder) {
    var folderName = getFolderName(folder.parentId, cache, file.name);
    return {
        sys: {
            type: 'Asset',
            id: getID('assets', 'category-banner-img', folderName)
        },
        fields: {
            title: {
                "en-US": folderName
            },
            description: {
                "en-US": "category-banner-img"
            },
            file: {
                "en-US": {
                    "url": alfresco.content.getContentUrl(file.id).slice(6),
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
    return {
        sys: {
            type: 'Asset',
            id: getID('assets', 'category-list-img', file.name)
        },
        fields: {
            title: {
                "en-US": file.name
            },
            description: {
                "en-US": "category-list-img"
            },
            file: {
                "en-US": {
                    "url": alfresco.content.getContentUrl(file.id).slice(6),
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

function getID(type, namespace, title) {
    var duplicateTitle;
    if (type === 'assets') {
        duplicateTitle = _.find(contentfulExportData.assets, (asset) => {
            if (!asset.fields.description || !asset.fields.title) return false;
            return asset.fields.description['en-US'] === namespace && asset.fields.title['en-US'] === title;
        });
    } else if (type === 'entries') {
        duplicateTitle = _.find(contentfulExportData.entries, (entry) => {
            if (entry.sys.contentType.sys.id !== namespace || !entry.fields.categoryId) return false;
            return entry.fields.categoryId['en-US'] === title;
        });
    }
    return duplicateTitle ? duplicateTitle.sys.id : uuid();
}

function getAllCategories() {
    var defer = q.defer();
    var options = {
        page: 1,
        pageSize: 100,
        depth: "all"
    }
    OrderCloud.Categories.List('Bachmans', options)
        .then(data => {
            var queue = [];
            while (options.page < data.Meta.TotalPages) {
                options.page = options.page + 1;
                queue.push(OrderCloud.Categories.List('Bachmans', options))
            }
            q.all(queue)
                .then(results => {
                    var items = _.concat(data.Items, _.flatten(_.map(results, 'Items')));
                    defer.resolve(items)
                })
        })
    return defer.promise;
}

function processBrowsePages(assets, categories) {
    return _.compact(_.map(categories, cat => {
        var bannerAsset = _.find(assets, asset => {
            if (!asset.fields.description || !asset.fields.title) return false;
            return (asset.fields.description["en-US"] === 'category-banner-img') && ((asset.fields.title["en-US"] === (cat.ID + '_CLP_ASpot')) || asset.fields.title["en-US"] === (cat.ID + '_PLP_ASpot'))
        });
        if (!bannerAsset) return;
        return {
            sys: {
                type: "Entry",
                id: getID('entries', 'browsePage', cat.ID),
                contentType: {
                    sys: {
                        id: "browsePage"
                    }
                }
            },
            fields: {
                categoryId: {
                    "en-US": cat.ID
                },
                bannerImage: {
                    "en-US": {
                        sys: {
                            type: "Link",
                            linkType: "Asset",
                            id: bannerAsset.sys.id
                        }
                    }
                }
            }
        }
    }))
}

function processProductImages(nodeChildren, assetCache) {
    var df = q.defer();
    var limitTo = 100;
    if (!assetCache) assetCache = [];
    console.log(`Mapping products ${assetCache.length} / ${nodeChildren.list.pagination.totalItems}`)
    assetCache = _.concat(assetCache, _.map(_.filter(nodeChildren.list.entries, obj => {
        return obj.entry.isFile && obj.entry.content.mimeType === 'image/jpeg';
    }), file => {
        return mapProductImage(file.entry);
    }))
    if (nodeChildren.list.pagination.hasMoreItems && assetCache.length < limitTo) {
        alfresco.nodes.getNodeChildren(alfrescoNodes.products, {
            skipCount: nodeChildren.list.pagination.skipCount + nodeChildren.list.pagination.count
        }).then(nextPageData => {
            df.resolve(processProductImages(nextPageData, assetCache))
        })
    } else {
        df.resolve(assetCache);
    }
    return df.promise;
}

function mapProductImage(file) {
    return {
        sys: {
            type: 'Asset',
            id: getID('assets', 'product-img', file.name.split('.')[0])
        },
        fields: {
            title: {
                "en-US": file.name.split('.')[0]
            },
            description: {
                "en-US": "product-img"
            },
            file: {
                "en-US": {
                    "url": alfresco.content.getContentUrl(file.id).slice(6),
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

app.get('/categories.json', (req, res) => {
    contentfulExportData = undefined;
    exec('contentful space export --config "./export_config.json"', (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return;
        }
        fs.readFile('./exports/contentful.json', 'utf8', (err, data) => {
            if (err) {
                console.log(`read error: ${err}`);
                return;
            }
            contentfulExportData = JSON.parse(data);
            alfresco.nodes.getNodeChildren(alfrescoNodes.categories)
                .then(processCategories)
                .then((assets) => {
                    getAllCategories()
                        .then((ocData) => {
                            assets = assets.splice(0, 10);
                            var data = JSON.stringify({
                                    entries: processBrowsePages(assets, ocData),
                                    assets: assets
                                }, null,
                                app.get('json spaces'));

                            fs.writeFile('./exports/categories.json', data, 'utf8', (err) => {
                                if (err) {
                                    res.send(err);
                                } else {
                                    res.sendFile(__dirname + '/exports/categories.json')
                                }
                            })
                        })
                })
                .catch((ex) => console.log(ex))
        })
    });
})

app.get('/products.json', (req, res) => {
    contentfulExportData = undefined;
    exec('contentful space export --config "./export_config.json"', (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return;
        }
        fs.readFile('./exports/contentful.json', 'utf8', (err, data) => {
            if (err) {
                console.log(`read error: ${err}`);
                return;
            }
            contentfulExportData = JSON.parse(data);
            alfresco.nodes.getNodeChildren(alfrescoNodes.products)
                .then(processProductImages)
                .then(productAssets => {

                    var data = JSON.stringify({
                            assets: productAssets
                        }, null,
                        app.get('json spaces'));

                    fs.writeFile('./exports/products.json', data, 'utf8', (err) => {
                        if (err) {
                            res.send(err);
                        } else {
                            res.sendFile(__dirname + '/exports/products.json')
                        }
                    })
                })
                .catch((ex) => console.log(ex))
        })
    });
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}!`);
    console.log('Logging into Alfresco...');
    alfresco.login('admin', 'R1v3tatbachmans')
        .then(data => console.log('Login successful:', data))
        .catch(ex => console.log('Login failed:', ex))

    console.log('Logging into OrderCloud');
    OrderCloud.Auth.ClientCredentials('W3lc0m31', '86E38B56-5AA3-4861-8992-7EBFECEE9B1C', ["CatalogReader", "CategoryReader"])
        .then((data) => {
            console.log('Login successful:', data.access_token);
            OrderCloud.ApiClient.instance.authentications['oauth2'].accessToken = data.access_token;
        })
        .catch(ex => console.log('Login failed:', ex))

})