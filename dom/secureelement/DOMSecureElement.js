/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2015, Deutsche Telekom, Inc. */

/* globals dump, Components, XPCOMUtils, DOMRequestIpcHelper, cpmm, SE,
   Services */

"use strict";

const DEBUG = true;
function debug(s) {
  if (DEBUG) {
    dump("-*- SecureElement DOM: " + s + "\n");
  }
}

const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "cpmm",
                                   "@mozilla.org/childprocessmessagemanager;1",
                                   "nsISyncMessageSender");

XPCOMUtils.defineLazyGetter(this, "SE", function() {
  let obj = {};
  Cu.import("resource://gre/modules/se_consts.js", obj);
  return obj;
});

/**
 * Helper object that maintains sessionObj and its corresponding
 * channelObj for a given SE type
 */
let SEStateHelper = {

  /*
    // Structure of '_stateInfoMap'.

    // 'sessionIds' and 'channelTokens' are uuids generated in parent process.
    // These unique ids are used to represent and manage the instances of
    // 'session' & 'channel' objects respectively.
    { 'uicc' : {
        reader: uiccReaderObj,
        sessions: {
          [uiccSessionId1: {
            session: uiccSesssionObj1,
            channels: [
              uiccChannelToken1: uiccChannelObj1,
              uiccChannelToken2: uiccChannelObj2
            ]
          },
          uiccSessionId2: {
            session: uiccSessionObj2,
            channels: [
              uiccChannelToken3: uiccChannelObj3
              ...
            ]
          ]}
        }
      },
      'eSE' : {
        reader: eseReaderObj
        ...
      }
    }
   */
  _stateInfoMap: {},

  addReaderObjs(readerObjs) {
    for (let index = 0; index < readerObjs.length; readerObjs++) {
      let aReaderObj = readerObjs[index];
      let sessionObj = {
        reader: aReaderObj,
        sessions: {}
      };
      this._stateInfoMap[aReaderObj.type] = sessionObj;
    }
  },

  getReaderObjByType(type) {
    let map = this._stateInfoMap[type];
    return (map ? map.reader : null);
  },

  deleteReaderObjByType(type) {
    let sessions = this._stateInfoMap[type].sessions;
    Object.keys(sessions).forEach((sessionId) => {
      if (sessions[sessionId]) {
        this.deleteSessionObjById(sessionId);
      }
    });
  },

  addSessionObj(sessionObj, aSessionInfo) {
    this._stateInfoMap[aSessionInfo.type].sessions[aSessionInfo.sessionId] = {
      session: sessionObj,
      channels: {}
    };
  },

  getSessionObjById(sessionId) {
    let keys = Object.keys(this._stateInfoMap);
    for (let i = 0; i < keys.length; i++) {
      let aKey = keys[i];
      let sessions = this._stateInfoMap[aKey].sessions;
      if (sessions[sessionId]) {
        return sessions[sessionId].session;
      }
    }
    return null;
  },

  deleteSessionObjById(sessionId) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      let aSession = sessions[sessionId];
      if (aSession) {
        let channels = aSession.channels;
        Object.keys(channels).forEach((aToken) => {
          this.deleteChannelObjByToken(aToken, sessionId);
        });
        delete aSession.session;
      }
    });
  },

  addChannelObj(channelObj, aChannelInfo) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      let aSession = sessions[aChannelInfo.sessionId];
      if (aSession) {
        aSession.channels[aChannelInfo.token] = channelObj;
      }
    });
  },

  getChannelObjByToken(channelToken) {
    let keys = Object.keys(this._stateInfoMap);
    for (let i = 0; i < keys.length; i++) {
      let aKey = keys[i];
      let sessions = this._stateInfoMap[aKey].sessions;
      let sessionKeys = Object.keys(sessions);
      for (let j = 0; j < sessionKeys.length; j++) {
        let aSessionKey = sessionKeys[j];
        return sessions[aSessionKey].channels[channelToken];
      }
    }
    return null;
  },

  deleteChannelObjByToken(channelToken, sessionId) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      let aSession = sessions[sessionId];
      if (aSession) {
        delete aSession.channels[channelToken];
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
    return this._createSEPromise((aResolverId) => {
      debug("SEError: " + aReason);
      this.takePromiseResolver(aResolverId).reject(aReason);
    });
  }
};

// Helper wrapper class to do promises related chores
let PromiseHelpers;

/**
 * Instance of 'SEReader' class is the connector to a secure element.
 * A reader may or may not have a secure element present, since some
 * secure elements are removable in nature (eg:- 'uicc'). These
 * Readers can be physical devices or virtual devices
 */
function SEReader(aType) {
  this.type = aType;
}

SEReader.prototype = {
  _window: null,

  classID: Components.ID("{1c7bdba3-cd35-4f8b-a546-55b3232457d5}"),
  contractID: "@mozilla.org/secureelement/SEReader;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(win) {
    this._window = win;
    this._isSEPresent = true;
  },

  openSession: function() {
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:OpenSession", {
        resolverId: aResolverId,
        type: this.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  closeAll: function() {
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:CloseAllByReader", {
        resolverId: aResolverId,
        type: this.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  get isSEPresent() {
    return this._isSEPresent;
  },

  set isSEPresent(isSEPresent) {
    this._isSEPresent = isSEPresent;
  }
};

/**
 * Instance of 'SESession' object represent a connection session
 * to one of the secure elements available on the device.
 * These objects can be used to get a communication channel with an application
 * hosted by the Secure Element.
 */
function SESession() {
  this._sessionId = null;
  this.reader = null;
}

SESession.prototype = {
  _window: null,

  classID: Components.ID("{2b1809f8-17bd-4947-abd7-bdef1498561c}"),
  contractID: "@mozilla.org/secureelement/SESession;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(win, result, data) {
    this._window = win;
    // Update the 'sessionId' that identifies and represents this
    // instance of the object
    this._sessionId = result.sessionId;
    this.reader = SEStateHelper.getReaderObjByType(data.type);
  },

  openLogicalChannel: function(aid) {
    this._checkClosed();
    // According to SIMalliance_OpenMobileAPI v4 spec,
    // in case of UICC it is recommended to reject the opening of the logical
    // channel without a specific AID.
    if (this.reader.type === SE.TYPE_UICC) {
      if (!aid || aid.length === 0) {
        return PromiseHelpers._rejectWithSEError(SE.ERROR_GENERIC +
                                                 " AID is not specified!");
      }
    }

    if (aid.length < SE.MIN_AID_LEN || aid.length > SE.MAX_AID_LEN) {
      return PromiseHelpers._rejectWithSEError(SE.ERROR_GENERIC +
            " Invalid AID length - " + aid.length);
    }

    // copy the aid
    this._aid = aid.subarray(0);
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:OpenChannel", {
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
      cpmm.sendAsyncMessage("SE:CloseAllBySession", {
        resolverId: aResolverId,
        sessionId: this._sessionId,
        type: this.reader.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  get isClosed() {
    return !SEStateHelper.getSessionObjById(this._sessionId) ? true : false;
  },

  _checkClosed: function() {
    if (this.isClosed) {
      throw new Error(SE.ERROR_BADSTATE + " Session Already Closed!");
    }
  }
};

/**
 * Instance of 'SECommand' dom object represent C-APDU to be sent to a
 * secure element.
 */
function SECommand() {
  this.cla = 0x00;
  this.ins = 0x00;
  this.p1 = 0xFF;
  this.p2 = 0xFF;
  this.data = null;
  this.le = -1;
}

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
 * Instance of 'SEChannel' object represent an ISO/IEC 7816-4 specification
 * channel opened to a secure element. It can be either a logical channel
 * or basic channel.
 */
function SEChannel() {
  this._aid = null;
  this._channelToken = null;
  this._sessionId = null;
  this._channelType = "logical";
  this.session = null;
  this.openResponse = null;
}

SEChannel.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  _window: null,

  classID: Components.ID("{181ebcf4-5164-4e28-99f2-877ec6fa83b9}"),
  contractID: "@mozilla.org/secureelement/SEChannel;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(win, result, data) {
    this._window = win;
    this._aid = data.aid;
    this._sessionId = data.sessionId;
    this._channelType = result.isBasicChannel ? "basic" : "logical";
    // Update the 'channel token' that identifies and represents this
    // instance of the object
    this._channelToken = result.channelToken;
    this.openResponse = Cu.cloneInto(new Uint8Array(result.openResponse), win);
    // Update 'session' obj
    this.session = SEStateHelper.getSessionObjById(this._sessionId);
  },

  transmit: function(command) {
    this._checkClosed();

    let dataLen = (!command.data) ? 0 : command.data.length;
    if ((SE.APDU_HEADER_LEN + dataLen) > SE.MAX_APDU_LEN) {
      return PromiseHelpers._rejectWithSEError(SE.ERROR_GENERIC +
             " Command length exceeds max limit - 255. " +
             " Extended APDU is not supported!");
    }

    let commandAPDU = {
      cla: command.cla,
      ins: command.ins,
      p1: command.p1,
      p2: command.p2,
      data: (!command.data) ? null : command.data,
      le: command.le
    };

    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:TransmitAPDU", {
        resolverId: aResolverId,
        apdu: commandAPDU,
        type: this.session.reader.type,
        sessionId: this._sessionId,
        channelToken: this._channelToken,
        aid: this._aid,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  close: function() {
    this._checkClosed();
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:CloseChannel", {
        resolverId: aResolverId,
        type: this.session.reader.type,
        sessionId: this._sessionId,
        channelToken: this._channelToken,
        aid: this._aid,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  get type() {
    return this._channelType;
  },

  set type(aChannelType) {
    this._channelType = aChannelType;
  },

  get isClosed() {
    return !SEStateHelper.getChannelObjByToken(this._channelToken) ? true : false;
  },

  _checkClosed: function() {
    if (this.isClosed) {
      throw new Error(SE.ERROR_BADSTATE +" Channel Already Closed!");
    }
  }
};

/**
 * Instance of 'SEResponse' object represent APDU response received
 * from a secure element.
 */
function SEResponse() {
  this.sw1 = 0x00;
  this.sw2 = 0x00;
  this.data = null;
  this.channel = null;
}

SEResponse.prototype = {
  classID: Components.ID("{58bc6c7b-686c-47cc-8867-578a6ed23f4e}"),
  contractID: "@mozilla.org/secureelement/SEResponse;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(result, data) {
    this.data = result.simResponse ?
      result.simResponse.slice(0) : null;
    // Update the status bytes
    this.sw1 = result.sw1;
    this.sw2 = result.sw2;
    // Update the channel obj
    this.channel = SEStateHelper.getChannelObjByToken(data.channelToken);
  }
};

/**
 * SEManager
 * @todo add docs
 */
function SEManager() {}

SEManager.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  _window: null,

  classID: Components.ID("{4a8b6ec0-4674-11e4-916c-0800200c9a66}"),
  contractID: "@mozilla.org/navigatorSEManager;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIDOMGlobalPropertyInitializer,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIObserver]),

  init: function init(win) {
    this._window = win;
    PromiseHelpers = new PromiseHelpersSubclass(this._window);

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
                      "SE:CloseAllBySessionRejected",
                      "SE:NotifySEPresent"];

    this.initDOMRequestHelper(win, messages);
  },

  uninit: function uninit() {
     this.destroyDOMRequestHelper();
     SEStateHelper.stateInfoMap = {};
     PromiseHelpers = null;
     this._window = null;
  },

  getSEReaders: function() {
    return PromiseHelpers._createSEPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:GetSEReaders", {
        resolverId: aResolverId,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  receiveMessage: function(aMessage) {
    let result = aMessage.json.result;
    let data = aMessage.json.metadata;
    let chromeObj = null;
    let contentObj = null;
    let resolver = null;
    debug("receiveMessage(): " + aMessage.name + " " + JSON.stringify(aMessage.json));

    if (data) {
      resolver = PromiseHelpers.takePromiseResolver(data.resolverId);
      if (!resolver) {
        return;
      }
    }

    switch (aMessage.name) {
      case "SE:GetSEReadersResolved":
        let availableReaders = [];
        for (let i = 0; i < result.readers.length; i++) {
          chromeObj = new SEReader(result.readers[i]);
          chromeObj.initialize(this._window);
          contentObj = this._window.SEReader._create(this._window, chromeObj);
          availableReaders.push(contentObj);
        }
        SEStateHelper.addReaderObjs(availableReaders);
        resolver.resolve(availableReaders);
        break;
      case "SE:OpenSessionResolved":
        chromeObj = new SESession();
        chromeObj.initialize(this._window, result, data);
        contentObj = this._window.SESession._create(this._window, chromeObj);
        SEStateHelper.addSessionObj(contentObj, {
          sessionId: result.sessionId,
          type: data.type
        });
        resolver.resolve(contentObj);
        break;
      case "SE:OpenChannelResolved":
        chromeObj = new SEChannel();
        chromeObj.initialize(this._window, result, data);
        contentObj = this._window.SEChannel._create(this._window, chromeObj);
        SEStateHelper.addChannelObj(contentObj, {
          token: result.channelToken,
          basicChannel: result.isBasicChannel,
          sessionId: data.sessionId,
          aid: data.aid
        });
        resolver.resolve(contentObj);
        break;
      case "SE:TransmitAPDUResolved":
        chromeObj = new SEResponse();
        chromeObj.initialize(result, data);
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
        SEStateHelper.deleteChannelObjByToken(data.channelToken,
                                              data.sessionId);
        resolver.resolve();
        break;
      case "SE:GetSEReadersRejected":
      case "SE:OpenSessionRejected":
      case "SE:OpenChannelRejected":
      case "SE:CloseChannelRejected":
      case "SE:TransmitAPDURejected":
      case "SE:CloseAllByReaderRejected":
      case "SE:CloseAllBySessionRejected":
        let error = data.error ? data.error : SE.ERROR_GENERIC;
        resolver.reject(error);
        break;
      case "SE:NotifySEPresent":
        let reader = SEStateHelper.getReaderObjByType(result.type);
        if (reader) {
          reader.isSEPresent = result.isPresent;
        }
        break;
      default:
        debug("Could not find a handler for " + aMessage.name);
        resolver.reject();
        break;
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([
  SECommand, SEResponse, SEChannel, SESession, SEReader, SEManager
]);
