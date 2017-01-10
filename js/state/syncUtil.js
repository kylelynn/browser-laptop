/* This Source Code Form is subject to the terms of the Mozilla Public * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const Immutable = require('immutable')
const writeActions = require('../constants/sync/proto').actions

const siteSettingDefaults = {
  hostPattern: '',
  zoomLevel: 0,
  shieldsUp: true,
  adControl: 1,
  cookieControl: 0,
  safeBrowsing: true,
  noScript: false,
  httpsEverywhere: true,
  fingerprintingProtection: false,
  ledgerPayments: true,
  ledgerPaymentsShown: true
}

/**
 * Given an objectId and category, return the matching browser object.
 * @param {Immutable.List} objectId
 * @param {string} category
 * @returns {Array} [<number|string>, <Immutable.Map>] e.g. ['https?://www.google.com', {Map of siteSetting}}
 */
module.exports.getObjectById = (objectId, category) => {
  const AppStore = require('../stores/appStore')
  const appState = AppStore.getState()
  switch (category) {
    case 'BOOKMARKS':
    case 'HISTORY_SITES':
      return appState.get('sites').findEntry((site, index) => {
        const itemObjectId = site.get('objectId')
        return (itemObjectId && itemObjectId.equals(objectId))
      })
    case 'PREFERENCES':
      return appState.get('siteSettings').findEntry((siteSetting, hostPattern) => {
        const itemObjectId = siteSetting.get('objectId')
        return (itemObjectId && itemObjectId.equals(objectId))
      })
    default:
      throw new Error(`Invalid object category: ${category}`)
  }
}

/**
 * Given a category and SyncRecord, get an existing browser object.
 * Used to respond to IPC GET_EXISTING_OBJECTS.
 * @param {string} categoryName
 * @param {Object} syncRecord
 * @returns {Object=}
 */
module.exports.getExistingObject = (categoryName, syncRecord) => {
  const AppStore = require('../stores/appStore')
  const appState = AppStore.getState()
  const objectId = new Immutable.List(syncRecord.objectId)
  const appStoreKeyValue = this.getObjectById(objectId, categoryName)
  if (!appStoreKeyValue) { return null }

  const existingObject = appStoreKeyValue[1].toJS()
  let item = undefined
  switch (categoryName) {
    case 'BOOKMARKS':
    case 'HISTORY_SITES':
      item = this.createSiteData(existingObject)
      break
    case 'PREFERENCES':
      const hostPattern = appStoreKeyValue[0]
      item = this.createSiteSettingsData(hostPattern, existingObject)
      break
    default:
      throw new Error(`Invalid category: ${categoryName}`)
  }
  return {
    action: writeActions.CREATE,
    deviceId: appState.getIn(['sync', 'deviceId']),
    objectData: item.name,
    objectId: item.objectId,
    [item.name]: item.value
  }
}

/**
 * Sets object id on a state entry.
 * @param {Immutable.Map} item
 * @returns {Immutable.map}
 */
module.exports.setObjectId = (item) => {
  if (!item || !item.toJS) {
    return
  }
  if (item.get('objectId')) {
    return item
  }
  const crypto = require('crypto')
  return item.set('objectId', new Immutable.List(crypto.randomBytes(16)))
}

/**
 * Gets current time in seconds
 */
module.exports.now = () => {
  return Math.floor(Date.now() / 1000)
}

/**
 * Checks whether an object is syncable as a record of the given type
 * @param {string} type
 * @param {Immutable.Map} item
 * @returns {boolean}
 */
module.exports.isSyncable = (type, item) => {
  if (type === 'bookmark' && item.get('tags')) {
    return (item.get('tags').includes('bookmark') ||
      item.get('tags').includes('bookmark-folder'))
  } else if (type === 'siteSetting') {
    for (let field in siteSettingDefaults) {
      if (item.has(field)) {
        return true
      }
    }
  }
  return false
}

/**
 * Sets a new object ID for an existing object in appState
 * @param {Array.<string>} objectPath - Path to get to the object from appState root,
 *   for use with Immutable.setIn
 * @returns {Array.<number>}
 */
module.exports.newObjectId = (objectPath) => {
  const crypto = require('crypto')
  const appActions = require('../actions/appActions')
  const objectId = new Immutable.List(crypto.randomBytes(16))
  appActions.setObjectId(objectId, objectPath)
  return objectId.toJS()
}

/**
 * Converts a site object into input for sendSyncRecords
 * @param {Object} site
 * @param {number=} siteIndex
 * @returns {{name: string, value: object, objectId: Array.<number>}}
 */
module.exports.createSiteData = (site, siteIndex) => {
  const siteData = {
    location: '',
    title: '',
    customTitle: '',
    lastAccessedTime: 0,
    creationTime: 0
  }
  for (let field in site) {
    if (field in siteData) {
      siteData[field] = site[field]
    }
  }
  if (module.exports.isSyncable('bookmark', Immutable.fromJS(site))) {
    if (!site.objectId && typeof siteIndex !== 'number') {
      throw new Error('Missing bookmark objectId.')
    }
    return {
      name: 'bookmark',
      objectId: site.objectId || module.exports.newObjectId(['sites', siteIndex]),
      value: {
        site: siteData,
        isFolder: site.tags.includes('bookmark-folder'),
        folderId: site.folderId || 0,
        parentFolderId: site.parentFolderId || 0
      }
    }
  } else if (!site.tags || !site.tags.length) {
    if (!site.objectId && typeof siteIndex !== 'number') {
      throw new Error('Missing historySite objectId.')
    }
    return {
      name: 'historySite',
      objectId: site.objectId || module.exports.newObjectId(['sites', siteIndex]),
      value: siteData
    }
  }
}

/**
 * Converts a site settings object into input for sendSyncRecords
 * @param {string} hostPattern
 * @param {Object} setting
 * @returns {{name: string, value: object, objectId: Array.<number>}}
 */
module.exports.createSiteSettingsData = (hostPattern, setting) => {
  const adControlEnum = {
    showBraveAds: 0,
    blockAds: 1,
    allowAdsAndTracking: 2
  }
  const cookieControlEnum = {
    block3rdPartyCookie: 0,
    allowAllCookies: 1
  }
  const value = Object.assign({}, siteSettingDefaults, {hostPattern})

  for (let field in setting) {
    if (field === 'adControl') {
      value.adControl = adControlEnum[setting.adControl]
    } else if (field === 'cookieControl') {
      value.cookieControl = cookieControlEnum[setting.cookieControl]
    } else if (field in value) {
      value[field] = setting[field]
    }
  }

  return {
    name: 'siteSetting',
    objectId: setting.objectId || module.exports.newObjectId(['siteSettings', hostPattern]),
    value
  }
}


/**
 * Deep modify object Uint8Array into Array.<Number> because IPC can't send
 * Uint8Array (see brave/sync issue #17). Returns a copy.
 */
const deepArrayify = (sourceObject) => {
  let object = Object.assign({}, sourceObject)
  const has = Object.prototype.hasOwnProperty.bind(object)
  for (let k in object) {
    if (!has(k) || object[k] instanceof Array) { continue }
    if (object[k] instanceof Uint8Array) {
      object[k] = Array.from(object[k])
    } else if (typeof object[k] === 'object') {
      object[k] = deepArrayify(Object.assign({}, object[k]))
    }
  }
  return object
}

module.exports.ipcSafeObject = (object) => {
  return deepArrayify(object)
}
