/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const Immutable = require('immutable')
const electron = require('electron')
const ipcMain = electron.ipcMain
const messages = require('../js/constants/sync/messages')
const categories = require('../js/constants/sync/proto').categories
const writeActions = require('../js/constants/sync/proto').actions
const config = require('../js/constants/appConfig').sync
const appActions = require('../js/actions/appActions')
const syncConstants = require('../js/constants/syncConstants')
const appDispatcher = require('../js/dispatcher/appDispatcher')
const AppStore = require('../js/stores/appStore')
const syncUtil = require('../js/state/syncUtil')

const categoryNames = Object.keys(categories)

const log = (message) => {
  console.log(`sync ${new Date().getTime()}:`, message)
}

let deviceId = null /** @type {Array|null} */
let pollIntervalId = null

/**
 * Sends sync records of the same category to the sync server.
 * @param {event.sender} sender
 * @param {number} action
 * @param {Array.<{name: string, value: Object}>} data
 */
const sendSyncRecords = (sender, action, data) => {
  if (!deviceId) {
    throw new Error('Cannot build a sync record because deviceId is not set')
  }
  if (!data || !data.length) {
    return
  }
  const category = syncUtil.CATEGORY_MAP[data[0].name]
  sender.send(messages.SEND_SYNC_RECORDS, category, data.map((item) => {
    if (!item || !item.name || !item.value) {
      return
    }
    return {
      action,
      deviceId,
      objectId: item.objectId,
      [item.name]: item.value
    }
  }))
}

const doAction = (sender, action) => {
  if (!action.item || !action.item.toJS) {
    return
  }
  // Only accept items who have an objectId set already
  if (!action.item.get('objectId')) {
    log(`Missing object ID! ${action.item.toJS()}`)
    return
  }
  switch (action.actionType) {
    case syncConstants.SYNC_ADD_SITE:
      sendSyncRecords(sender, writeActions.CREATE,
        [syncUtil.createSiteData(action.item.toJS())])
      break
    case syncConstants.SYNC_UPDATE_SITE:
      sendSyncRecords(sender, writeActions.UPDATE,
        [syncUtil.createSiteData(action.item.toJS())])
      break
    case syncConstants.SYNC_REMOVE_SITE:
      sendSyncRecords(sender, writeActions.DELETE,
        [syncUtil.createSiteData(action.item.toJS())])
      break
    case syncConstants.SYNC_CLEAR_HISTORY:
      sender.send(messages.DELETE_SYNC_CATEGORY, syncUtil.CATEGORY_MAP.historySite)
      break
    case syncConstants.SYNC_ADD_SITE_SETTING:
      if (syncUtil.isSyncable('siteSetting', action.item)) {
        sendSyncRecords(sender, writeActions.CREATE,
          [syncUtil.createSiteSettingsData(action.hostPattern, action.item.toJS())])
      }
      break
    case syncConstants.SYNC_UPDATE_SITE_SETTING:
      if (syncUtil.isSyncable('siteSetting', action.item)) {
        sendSyncRecords(sender, writeActions.UPDATE,
          [syncUtil.createSiteSettingsData(action.hostPattern, action.item.toJS())])
      }
      break
    case syncConstants.SYNC_REMOVE_SITE_SETTING:
      sendSyncRecords(sender, writeActions.DELETE,
        [syncUtil.createSiteSettingsData(action.hostPattern, action.item.toJS())])
      break
    case syncConstants.SYNC_CLEAR_SITE_SETTINGS:
      sender.send(messages.DELETE_SYNC_SITE_SETTINGS)
      // TODO: sync-client should listen for this message and delete
      // all existing synced site settings
      break
    default:
  }
}

/**
 * Called when sync client is done initializing.
 * @param {boolean} isFirstRun - whether this is the first time sync is running
 * @param {Event} e
 */
module.exports.onSyncReady = (isFirstRun, e) => {
  appDispatcher.register(doAction.bind(null, e.sender))
  if (isFirstRun) {
    // Sync the device id for this device
    sendSyncRecords(e.sender, writeActions.CREATE, [{
      name: 'device',
      objectId: syncUtil.newObjectId(['sync']),
      value: {
        name: 'browser-laptop' // todo: support user-chosen names
      }
    }])
  }
  // Sync bookmarks that have not been synced yet
  const appState = AppStore.getState()
  const sites = appState.get('sites') || new Immutable.List()
  sites.forEach((site, i) => {
    if (site && !site.get('objectId') && syncUtil.isSyncable('bookmark', site)) {
      sendSyncRecords(e.sender, writeActions.CREATE,
        [syncUtil.createSiteData(site.toJS(), i)])
    }
  })
  // Sync site settings in case they changed while sync was disabled
  const siteSettings =
    appState.get('siteSettings').filter((value, key) => {
      return syncUtil.isSyncable('siteSetting', value)
    }).toJS()
  if (siteSettings) {
    sendSyncRecords(e.sender, writeActions.UPDATE,
      Object.keys(siteSettings).map((item) => {
        return syncUtil.createSiteSettingsData(item, siteSettings[item])
      }))
  }
  ipcMain.on(messages.GET_EXISTING_OBJECTS, (event, categoryName, records) => {
    log(`getting existing objects for ${records.length} ${categoryName}`)
    if (!categoryNames.includes(categoryName) || !records || !records.length) {
      return
    }
    const recordsAndExistingObjects = records.map((record) => {
      const safeRecord = syncUtil.ipcSafeObject(record)
      const existingObject = syncUtil.getExistingObject(categoryName, record)
      return [safeRecord, existingObject]
    })
    e.sender.send(messages.RESOLVE_SYNC_RECORDS, categoryName, recordsAndExistingObjects)
  })
  ipcMain.on(messages.RESOLVED_SYNC_RECORDS, (event, categoryName, records) => {
    if (!records || !records.length) {
      return
    }
    log(`applying ${records.length} resolved ${categoryName}.`)
    for (let record of records) { syncUtil.applySyncRecord(record) }
  })
  // Periodically poll for new records
  let startAt = appState.getIn(['sync', 'lastFetchTimestamp']) || 0
  const poll = () => {
    e.sender.send(messages.FETCH_SYNC_RECORDS, categoryNames, startAt)
    startAt = syncUtil.now()
    appActions.saveSyncInitData(null, null, startAt)
  }
  poll()
  pollIntervalId = setInterval(poll, config.fetchInterval)
}

module.exports.init = function (initialState) {
  if (config.enabled !== true) {
    return
  }
  ipcMain.on(messages.GET_INIT_DATA, (e) => {
    const seed = initialState.seed || null
    deviceId = initialState.deviceId || null
    e.sender.send(messages.GOT_INIT_DATA, seed, deviceId, config)
  })
  ipcMain.on(messages.SAVE_INIT_DATA, (e, seed, newDeviceId) => {
    if (!deviceId && newDeviceId) {
      deviceId = Array.from(newDeviceId)
    }
    appActions.saveSyncInitData(new Immutable.List(seed),
      new Immutable.List(newDeviceId))
  })
  ipcMain.on(messages.SYNC_READY, module.exports.onSyncReady.bind(null,
    !initialState.seed && !initialState.deviceId))
  ipcMain.on(messages.SYNC_DEBUG, (e, msg) => {
    log(msg)
  })
}

module.exports.stop = function () {
  clearInterval(pollIntervalId)
}
