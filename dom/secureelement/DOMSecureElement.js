/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2014, Deutsche Telekom, Inc. */

"use strict";

const DEBUG = true;
function debug(s) {
  if (DEBUG) {
    dump("-*- SecureElement DOM: " + s + "\n");
  }
}

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "cpmm",
                                   "@mozilla.org/childprocessmessagemanager;1",
                                   "nsISyncMessageSender");

XPCOMUtils.defineLazyServiceGetter(this, "iccProvider",
                   "@mozilla.org/ril/content-helper;1",
                   "nsIIccProvider");

XPCOMUtils.defineLazyGetter(this, "SE", function() {
  let obj = {};
  Cu.import("resource://gre/modules/se_consts.js", obj);
  return obj;
});

/*
 * Helper object that maintains sessionObj and its corresponding
 * channelObj for a given SE type
 */
let SEStateHelper = {

  /*
     ------------------------------
       Structure of 'stateInfoMap':
     ------------------------------
     { ['uicc' :
                 reader : readerObj1
                 sessions :
                           { [xxxxx : // 'sessionId'
                                     channels : { [aaaaa: // 'channelToken' 1 (key 1)
                                                           channelObj 1 ]
                                                  [bbbbb: // 'channelToken' 2 (key 2)
                                                           channelObj 2 ]
                                                }
                             ]
                             [yyyyy : // 'sessionId'
                                     channels : { [ccccc: // 'channelToken' 3 (key 1)
                                                           channelObj 3 ]
                                                  [ddddd: // 'channelToken' 4 (key 2)
                                                           channelObj 4 ]
                                                }
                             ]
                          } // End of 'sessions'
       ]
       [ 'eSE' :
                 reader : readerObj2
                 sessions :
                              { [..... : ..]
                                [..... : ..]
                              }
       ]
     }
  */

  _stateInfoMap: {},

  addReaderObjs(readerObjs) {
    for (let index = 0; index < readerObjs.length; readerObjs++) {
      let aReaderObj = readerObjs[index];
      let sessionObj = { reader: aReaderObj,
                         sessions: {} };
      this._stateInfoMap[aReaderObj.type] = sessionObj;
    }
  },

  getReaderObjByType(type) {
    return this._stateInfoMap[type].reader;
  },

  deleteReaderObjByType(type) {
    let sessions = this._stateInfoMap[type].sessions;
    Object.keys(sessions).forEach((sessionId) => {
      if (sessions[sessionId])
        delete this.deleteSessionObjById(sessionId);
    });
  },

  addSessionObj(sessionObj, aInfo) {
    this._stateInfoMap[aInfo.type].sessions[aInfo.sessionId] = { session: sessionObj,
                                                                 channels: {} };
  },

  getSessionObjById(sessionId) {
    let keys = Object.keys(this._stateInfoMap);
    for (let i = 0; i < keys.length; i++) {
      let sessions = this._stateInfoMap[keys[i]].sessions;
      if (sessions[sessionId])
        return sessions[sessionId].session;
    }
  },

  deleteSessionObjById(sessionId) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      if (sessions[sessionId]) {
        let channels = sessions[sessionId].channels;
        Object.keys(channels).forEach((aToken) => {
          this.deleteChannelObjByToken(aToken, sessionId);
        });
        delete sessions[sessionId].session;
      }
    });
  },

  addChannelObj(channelObj, aInfo) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      if (sessions[aInfo.sessionId])
        sessions[aInfo.sessionId].channels[aInfo.token] = channelObj;
    });
  },

  getChannelObjByToken(channelToken) {
    let keys = Object.keys(this._stateInfoMap);
    for (let i = 0; i < keys.length; i++) {
      let sessions = this._stateInfoMap[keys[i]].sessions;
      let sessionKeys = Object.keys(sessions);
      for (let j = 0; j < sessionKeys.length; j++) {
        let channels = sessions[sessionKeys[j]].channels;
        if (channels[channelToken])
          return channels[channelToken];
      }
    }
  },

  deleteChannelObjByToken(channelToken, sessionId) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      if (sessions[sessionId] &&
          sessions[sessionId].channels[channelToken]) {
        delete sessions[sessionId].channels[channelToken];
      }
    });
  }
};

function PromiseHelpersSubclass(win) {
   this._window = win;
}
PromiseHelpersSubclass.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  _window: null,

  _createSEPromise: function(aCallback) {
    return this.createPromise((aResolve, aReject) => {
      let resolverId = this.getPromiseResolverId({
        resolve: aResolve,
        reject: aReject
      });
      aCallback(resolverId);
    });
  },


  _rejectWithSEError: function(aReason) {
    let self = this;
    return this._createSEPromise(function(aResolverId) {
      if (DEBUG) debug('SEError: ' + aReason);
      self.takePromiseResolver(aResolverId).reject(aReason);
    });
  }
};

// Helper wrapper class to do promises related chores
let PromiseHelpers;

/**
 * ==============================================
 * SECommand
 * ==============================================
 */
function SECommand() {}
SECommand.prototype = {
  __init: function(cla, ins, p1, p2, data, le) {
    this.cla = cla;
    this.ins = ins;
    this.p1 = p1;
    this.p2 = p2;
    this.data = data;
    this.le = le;
  },

  classID: Components.ID("{cb8ccb1c-0e99-4a62-bf7d-11acc13848e0}"),
  contractID: "@mozilla.org/secureelement/SECommand;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports]),
};

/**
 * ==============================================
 * SEResponse
 * ==============================================
 */

function SEResponse(aResponseInfo) {
  this.sw1 = 0x00;
  this.sw2 = 0x00;
  this.data = null;

  this.channel = SEStateHelper.getChannelObjByToken(aResponseInfo.token);
  let apduResponse = aResponseInfo.response;
  if (!apduResponse.simResponse || apduResponse.simResponse.length === 0) {
    if (DEBUG) debug('APDU Response: Empty / Not Set!');
  } else {
    this.data = apduResponse.simResponse.slice(0, apduResponse.length);
  }

  // Update the status bytes
  this.sw1 = apduResponse.sw1;
  this.sw2 = apduResponse.sw2;
}

SEResponse.prototype = {
  classID: Components.ID("{58bc6c7b-686c-47cc-8867-578a6ed23f4e}"),
  contractID: "@mozilla.org/secureelement/SEResponse;1",
  QueryInterface: XPCOMUtils.generateQI([]),
};

/**
 * ==============================================
 * SEChannel
 * ==============================================
 */

function SEChannel(aChannelInfo) {
  this._aid = aChannelInfo.aid;
  this._channelToken = aChannelInfo.token;
  this._sessionId = aChannelInfo.sessionId;
  this.session = null;
  this.openResponse = null;
}

SEChannel.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  _window: null,

  classID: Components.ID("{181ebcf4-5164-4e28-99f2-877ec6fa83b9}"),
  contractID: "@mozilla.org/secureelement/SEChannel;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function ic_initialize(win, openResponse) {
    this._window = win;
    this.openResponse = Cu.cloneInto(new Uint8Array(openResponse), win);
    // Update 'session' obj
    this.session = SEStateHelper.getSessionObjById(this._sessionId);
    // Update the type
    this._type = this.session.reader.type;
  },

  transmit: function(command) {
    this._checkClosed();

    let dataLen = (!command.data) ? 0 : command.data.length;
    if ((SE.APDU_HEADER_LEN + dataLen) > SE.MAX_APDU_LEN)
      return PromiseHelpers._rejectWithSEError('SEGenericError: ' +
        "Command length exceeds max limit - 255. Extended APDU is not supported!");

    let commandAPDU = {
      cla: command.cla & 0xFF,
      ins: command.ins & 0xFF,
      p1: command.p1 & 0xFF,
      p2: command.p2 & 0xFF,
      data: (!command.data) ? null : command.data,
      le: command.le
    };
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:TransmitAPDU",
                            {
                              resolverId: aResolverId,
                              apdu: commandAPDU,
                              channelToken: this._channelToken,
                              type: this._type,
                              aid: this._aid,
                              sessionId: this._sessionId,
                              appId: this._window.document.nodePrincipal.appId
                            });
    });
  },

  close: function() {
    this._checkClosed();
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:CloseChannel",
                            {
                              resolverId: aResolverId,
                              channelToken: this._channelToken,
                              aid: this._aid,
                              sessionId: this._sessionId,
                              appId: this._window.document.nodePrincipal.appId
                            });
    });
  },

  get isClosed() {
    return cpmm.sendSyncMessage("SE:IsChannelClosed",
                                {
                                  channelToken: this._channelToken,
                                  sessionId: this._sessionId,
                                  appId: this._window.document.nodePrincipal.appId
                                })[0];
  },

  get type() {
    let type = cpmm.sendSyncMessage("SE:GetChannelType",
                                    {
                                      channelToken: this._channelToken,
                                      sessionId: this._sessionId,
                                      appId: this._window.document.nodePrincipal.appId
                                    });
    // The array values must match the enum value of 'SEChannelType' specified in webidl.
    return ['basic', 'logical'][type];
  },

  _checkClosed: function() {
    if (this.isClosed === true) {
      throw new Error("SEBadStateError: Channel Already Closed!");
    }
  }
};

/**
 * ==============================================
 * SESession
 * ==============================================
 */

function SESession(aSessionInfo) {
  this._sessionId = aSessionInfo.sessionId;
  this.reader = SEStateHelper.getReaderObjByType(aSessionInfo.type);
}

SESession.prototype = {
  _window: null,

  classID: Components.ID("{2b1809f8-17bd-4947-abd7-bdef1498561c}"),
  contractID: "@mozilla.org/secureelement/SESession;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function ic_initialize(win) {
    this._window = win;
  },

  openBasicChannel: function(aid) {
    // Not Supported for now!
    return PromiseHelpers._rejectWithSEError('SEGenericError: ' +
      "OpenBasicChannel() is not supported for SE type : " + SE.TYPE_UICC);
  },

  openLogicalChannel: function(aid) {
    this._checkClosed();
    // According to SIMalliance_OpenMobileAPI v3 draft:
    // In case of UICC it is recommended to reject the opening of the logical
    // channel without a specific AID.
    if (!aid || aid.length === 0) {
      if (this.reader.type === SE.TYPE_UICC)
        return PromiseHelpers._rejectWithSEError('SEGenericError: ' +
                                                  "AID is not specified!");
    }

    if (aid.length < SE.MIN_AID_LEN || aid.length > SE.MAX_AID_LEN)
      return PromiseHelpers._rejectWithSEError('SEGenericError: ' +
                                               "Invalid AID length - " + aid.length);

    this._aid = Cu.waiveXrays(aid);
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:OpenChannel",
                            {
                              resolverId: aResolverId,
                              aid: this._aid,
                              sessionId: this._sessionId,
                              type: this.reader.type,
                              appId: this._window.document.nodePrincipal.appId
                            });
    });
  },

  closeAll: function() {
    this._checkClosed();
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:CloseAllBySession",
                            {
                              resolverId: aResolverId,
                              sessionId: this._sessionId,
                              type: this.reader.type,
                              appId: this._window.document.nodePrincipal.appId
                            });
    });
  },

  get isClosed() {
    return cpmm.sendSyncMessage("SE:IsSessionClosed",
                                {
                                  sessionId: this._sessionId,
                                  appId: this._window.document.nodePrincipal.appId
                                })[0];
  },

  get atr() {
    // 'Answer to Reset' is not supported for now, return null.
    return null;
  },

  _checkClosed: function() {
    if (this.isClosed === true) {
      throw new Error("SEBadStateError: Session Already Closed!");
    }
  }
};

/**
 * ==============================================
 * SEReader
 * ==============================================
 */

function SEReader(aType) {
  this.type = aType;
}

SEReader.prototype = {
  _window: null,

  classID: Components.ID("{1c7bdba3-cd35-4f8b-a546-55b3232457d5}"),
  contractID: "@mozilla.org/secureelement/SEReader;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function ic_initialize(win) {
    this._window = win;
  },

  openSession: function() {
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:OpenSession",
                            {
                              resolverId: aResolverId,
                              type: this.type,
                              appId: this._window.document.nodePrincipal.appId
                            });
    });
  },

  closeAll: function() {
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:CloseAllByReader",
                            {
                              resolverId: aResolverId,
                              type: this.type,
                              appId: this._window.document.nodePrincipal.appId
                            });
    });
  },

  get isSEPresent() {
    return cpmm.sendSyncMessage("SE:IsSEPresent",
                                {
                                  type: this.type,
                                  appId: this._window.document.nodePrincipal.appId
                                });
  }
};

/**
 * ==============================================
 * SEManager
 * ==============================================
 */
function SEManager() {}

SEManager.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  _window: null,

  _isAllowed: false,

  classID: Components.ID("{4a8b6ec0-4674-11e4-916c-0800200c9a66}"),
  contractID: "@mozilla.org/navigatorSEManager;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIDOMGlobalPropertyInitializer,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIObserver]),

  init: function SEManagerInit(win) {
    this._window = win;
    PromiseHelpers = new PromiseHelpersSubclass(this._window);
    this.innerWindowID = win.QueryInterface(Ci.nsIInterfaceRequestor)
                            .getInterface(Ci.nsIDOMWindowUtils)
                            .currentInnerWindowID;

    let principal = win.document.nodePrincipal;
    let perm = Services.perms.testExactPermissionFromPrincipal(principal,
                                                               "secureelement-manage");
    if (perm === Ci.nsIPermissionManager.ALLOW_ACTION) {
      this._isAllowed = true;
    }

    // Add the messages to be listened to.
    const messages = ["SE:GetSEReadersResolved",
                      "SE:OpenSessionResolved",
                      "SE:OpenChannelResolved",
                      "SE:CloseChannelResolved",
                      "SE:TransmitAPDUResolved",
                      "SE:CloseAllByReaderResolved",
                      "SE:CloseAllBySessionResolved",
                      "SE:GetSEReadersRejected",
                      "SE:OpenSessionRejected",
                      "SE:OpenChannelRejected",
                      "SE:CloseChannelRejected",
                      "SE:TransmitAPDURejected",
                      "SE:CloseAllByReaderRejected",
                      "SE:CloseAllBySessionRejected"];

    this.initDOMRequestHelper(win, messages);
  },

  uninit: function SEManagerUninit() {
     this.destroyDOMRequestHelper();
     SEStateHelper.stateInfoMap = {};
     PromiseHelpers = null;
     this._window = null;
  },

  _ensureAccess: function() {
    if (!this._isAllowed) {
      throw new this._window.DOMError("Security Exception!",
                                      "Should have 'secureelement-manage' permssion.");
    }
  },

  getSEReaders: function() {
    if (!this._isAllowed)
      return PromiseHelpers._rejectWithSEError('SESecurityError: ' +
        "Security Exception! Should have 'secureelement-manage' permssion.");

    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:GetSEReaders",
                            {
                              resolverId: aResolverId,
                              appId: this._window.document.nodePrincipal.appId
                            });
    });
  },

  receiveMessage: function(aMessage) {
    let data = aMessage.json;
    let chromeObj = null;
    let contentObj = null;
    debug("receiveMessage(): " + aMessage.name + " " + JSON.stringify(data));

    let resolver = PromiseHelpers.takePromiseResolver(data.resolverId);
    if (!resolver) {
      return;
    }

    switch (aMessage.name) {
      case "SE:GetSEReadersResolved":
        let availableReaders = this._window.Array();
        if (data.readers.indexOf(SE.TYPE_UICC) > -1) {
          chromeObj = new SEReader(SE.TYPE_UICC);
          chromeObj.initialize(this._window);
          contentObj = this._window.SEReader._create(this._window, chromeObj);
          availableReaders.push(contentObj);
        }
        // Update 'readers'
        SEStateHelper.addReaderObjs(availableReaders);
        resolver.resolve(availableReaders);
        break;
      case "SE:OpenSessionResolved":
        chromeObj = new SESession({ sessionId: data.sessionId, type: data.type });
        chromeObj.initialize(this._window);
        contentObj = this._window.SESession._create(this._window, chromeObj);
        // Update the session obj
        SEStateHelper.addSessionObj(contentObj, { sessionId: data.sessionId,
                                                  type: data.type });
        resolver.resolve(contentObj);
        break;
      case "SE:OpenChannelResolved":
        chromeObj = new SEChannel({ aid: data.aid,
                                    token: data.channelToken,
                                    sessionId: data.sessionId });
        chromeObj.initialize(this._window, data.openResponse);
        contentObj = this._window.SEChannel._create(this._window, chromeObj);
        // Update 'channel obj'
        SEStateHelper.addChannelObj(contentObj, { sessionId: data.sessionId,
                                                  token: data.channelToken });
        resolver.resolve(contentObj);
        break;
      case "SE:TransmitAPDUResolved":
        chromeObj = new SEResponse({ response: data.respApdu, token: data.channelToken });
        contentObj = this._window.SEResponse._create(this._window, chromeObj);
        resolver.resolve(contentObj);
        break;
      case "SE:CloseAllByReaderResolved":
        // Clear the state in SEStateHelper obj
        SEStateHelper.deleteReaderObjByType(data.type);
        resolver.resolve();
        break;
      case "SE:CloseAllBySessionResolved":
        // Clear the state in SEStateHelper obj
        SEStateHelper.deleteSessionObjById(data.sessionId);
        resolver.resolve();
        break;
      case "SE:CloseChannelResolved":
        // Clear the state in SEStateHelper obj
        SEStateHelper.deleteChannelObjByToken(data.channelToken, data.sessionId);
        resolver.resolve();
        break;
      case "SE:GetSEReadersRejected":
      case "SE:OpenSessionRejected":
      case "SE:OpenChannelRejected":
      case "SE:CloseChannelRejected":
      case "SE:TransmitAPDURejected":
      case "SE:CloseAllByReaderRejected":
      case "SE:CloseAllBySessionRejected":
        let error = data.error ? data.error : 'SEGenericError';
        resolver.reject(reason);
        break;
      default:
        debug("Could not find a handler for " + aMessage.name);
        resolver.reject();
        break;
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SECommand,
                                                     SEResponse,
                                                     SEChannel,
                                                     SESession,
                                                     SEReader,
                                                     SEManager]);
