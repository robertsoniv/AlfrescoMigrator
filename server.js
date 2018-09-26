const express = require('express')
const AlfrescoApi = require('alfresco-js-api-node')
const OrderCloud = require('ordercloud-javascript-sdk')
const config = require('./config');
const _ = require('lodash')
const q = require('q')
const fs = require('fs')
const uuid = require('uuid/v4')
const {
    exec
} = require('child_process')
const port = 3000

//EXPRESS SERVER
const app = express()

//JSON FORMATTING
app.set('json spaces', 2);
let contentfulExportData
let blockAllRequests

//ALFRESCO CLIENT
const alfresco = new AlfrescoApi({
    hostEcm: config.alfresco.host
});

//ENDPOINTS
app.get('/export/categories.json', (req, res) => {
    if (blockAllRequests) {
        res.status(403).end();
    } else {
        contentfulSpaceExport()
            .then(exportAlfrescoCategories)
            .then(path => res.sendFile(path))
            .catch(error => res.status(500).send(error));
    }
})

app.get('/export/products.json', (req, res) => {
    if (blockAllRequests) {
        res.status(403).end();
    } else {
        contentfulSpaceExport()
            .then(exportAlfrescoProducts)
            .then(path => res.sendFile(path))
            .catch(error => res.status(500).send(error));
    }
})

//FUNCTIONS
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
    if (config.alfresco.nodes.categories === id) return origName;
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

function processProducts(nodeChildren, assetCache) {
    var df = q.defer();
    var limitTo = 400;
    if (!assetCache) assetCache = [];
    var startLength = assetCache.length;
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(`Mapping Alfresco product nodes ${startLength} / ${nodeChildren.list.pagination.totalItems}`)
    assetCache = _.concat(assetCache, _.map(_.filter(nodeChildren.list.entries, obj => {
        return obj.entry.isFile && obj.entry.content.mimeType === 'image/jpeg';
    }), file => {
        startLength++;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        process.stdout.write(`Mapping Alfresco product nodes ${startLength} / ${nodeChildren.list.pagination.totalItems}`)
        return mapProductImage(file.entry);
    }))
    if (nodeChildren.list.pagination.hasMoreItems && assetCache.length < limitTo) {
        alfresco.nodes.getNodeChildren(config.alfresco.nodes.products, {
            skipCount: nodeChildren.list.pagination.skipCount + nodeChildren.list.pagination.count
        }).then(nextPageData => {
            df.resolve(processProducts(nextPageData, assetCache))
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

function contentfulSpaceExport() {
    var df = q.defer();
    contentfulExportData = undefined;
    process.stdout.write("Exporting latest Contentful space...");
    exec('contentful space export --config "./export_config.json"', (error, stdout, stderr) => {
        if (error) {
            df.reject(error);
            console.error(`Space Export exec error: ${error}`);
        } else {
            process.stdout.write('\n');
            process.stdout.write(stdout);
            process.stdout.write('\n');
            process.stdout.write('\n');
            fs.readFile('./exports/contentful.json', 'utf8', (err, data) => {
                if (err) {
                    df.reject(error);
                    console.log(`Space Export read error: ${err}`);
                } else {
                    contentfulExportData = JSON.parse(data);
                    df.resolve(contentfulExportData);
                }
            })
        }
    })
    return df.promise;
}

function exportAlfrescoCategories() {
    var df = q.defer();
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write('Exporting Alfresco category nodes...')
    alfresco.nodes.getNodeChildren(config.alfresco.nodes.categories)
        .then(processCategories)
        .then((assets) => {
            process.stdout.clearLine();
            process.stdout.cursorTo(0);
            process.stdout.write('Retrieving OrderCloud categories...');
            getAllCategories()
                .then((ocData) => {
                    process.stdout.clearLine();
                    process.stdout.cursorTo(0);
                    process.stdout.write('Writing result to export.json file...')
                    try {
                        var entries = processBrowsePages(assets, ocData);
                        var data = JSON.stringify({
                                entries: entries,
                                assets: assets
                            }, null,
                            app.get('json spaces'));
                    } catch (error) {
                        console.log('Failed to parse category export JSON data', error);
                        df.reject(error);
                        return;
                    }


                    fs.writeFile('./exports/categories.json', data, 'utf8', (err) => {
                        if (err) {
                            console.log('Failed to write to ./exports/categories.json', err);
                            df.reject(err);
                        } else {
                            process.stdout.clearLine();
                            process.stdout.cursorTo(0);
                            process.stdout.write(`Successfully exported ${assets.length} assets and ${entries.length} entries to ./exports/categories.json.\n`);
                            df.resolve(__dirname + '/exports/categories.json');
                        }
                    })
                })
                .catch(ex => {
                    console.log('Failed to get all ordercloud categories', ex);
                })
        })
        .catch(ex => {
            console.log('Failed to export alfresco categories', ex);
            df.reject(ex);
        })
    return df.promise;
}

function exportAlfrescoProducts() {
    var df = q.defer();
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(`Mapping Alfresco product nodes 0 / 0`);
    alfresco.nodes.getNodeChildren(config.alfresco.nodes.products)
        .then(processProducts)
        .then((assets) => {
            process.stdout.clearLine();
            process.stdout.cursorTo(0);
            process.stdout.write('Writing result to export.json file...')
            try {
                var data = JSON.stringify({
                        assets: assets
                    }, null,
                    app.get('json spaces'));
            } catch (error) {
                console.log('Failed to parse product export JSON data', error);
                df.reject(error);
                return;
            }

            fs.writeFile('./exports/products.json', data, 'utf8', (err) => {
                if (err) {
                    console.log('Failed to write to ./exports/products.json', err);
                    df.reject(err);
                } else {
                    process.stdout.clearLine();
                    process.stdout.cursorTo(0);
                    process.stdout.write(`Successfully exported ${assets.length} assets to ./exports/products.json.\n`);
                    df.resolve(__dirname + '/exports/products.json');
                }
            })
        })
        .catch(ex => {
            console.log('Failed to export alfresco products', ex);
            df.reject(ex);
        })
    return df.promise;
}

app.listen(port, () => {
    console.log(`Alfresco Migragor listening on port ${port}`);
    console.log('Authenticating...')
    var loginCount = 0;

    function loginCheck() {
        loginCount++;
        if (loginCount === 2) console.log('Migrator Authenticated. Application Ready.')
    }
    //AUTHENTICATE ALFRESCO
    alfresco.login(config.alfresco.username, config.alfresco.password)
        .then(data => {
            console.log('Logged into Alfresco');
            loginCheck();
        })
        .catch(ex => {
            console.log('Alfresco Login Failed', ex);
            blockAllRequests = true;
        })

    //AUTHENTICATE ORDERCLOUD (CLIENT CREDENTIALS OAUTH 2.0 WORKFLOW)
    OrderCloud.Auth.ClientCredentials(config.ordercloud.secret, config.ordercloud.clientId, config.ordercloud.scope)
        .then((data) => {
            console.log('Logged into OrderCloud');
            OrderCloud.ApiClient.instance.authentications['oauth2'].accessToken = data.access_token;
            loginCheck();
        })
        .catch(ex => {
            console.log('OrderCloud Login Failed:', ex);
            blockAllRequests = true;
        })

})