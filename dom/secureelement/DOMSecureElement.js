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

    // 'sessionTokens' and 'channelTokens' are uuids generated in parent process.
    // These unique ids are used to represent and manage the instances of
    // 'session' & 'channel' objects respectively.
    { 'uicc' : {
        reader: uiccReaderObj,
        sessions: {
          [uiccSessionToken1: {
            session: uiccSesssionObj1,
            channels: [
              uiccChannelToken1: uiccChannelObj1,
              uiccChannelToken2: uiccChannelObj2
            ]
          },
          uiccSessionToken2: {
            session: uiccSessionObj2,
            channels: [
              uiccChannelToken3: uiccChannelObj3
              ...
            ]
          ]}
        }
      },
      'eSE' : {
        reader: eSEReaderObj
        ...
      }
    }
   */
  _stateInfoMap: {},

  addReaderObjs(readerObjs) {
    for (let index = 0; index < readerObjs.length; index++) {
      let readerObj = readerObjs[index];
      let readerInfo = {
        reader: readerObj,
        sessions: {}
      };
      this._stateInfoMap[readerObj.type] = readerInfo;
    }
  },

  getReaderObjByType(type) {
    let readerInfo = this._stateInfoMap[type];
    return (readerInfo ? readerInfo.reader : null);
  },

  deleteReaderObjByType(type) {
    let sessions = this._stateInfoMap[type].sessions;
    Object.keys(sessions).forEach((sessionToken) => {
      this.deleteSessionObjById(sessionToken);
    });
  },

  addSessionObj(sessionObj, sessionInfo) {
    this._stateInfoMap[sessionInfo.type].sessions[sessionInfo.sessionToken] = {
      session: sessionObj,
      channels: {}
    };
  },

  getSessionObjById(sessionToken) {
    let keys = Object.keys(this._stateInfoMap);
    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      let sessions = this._stateInfoMap[key].sessions;
      if (sessions[sessionToken]) {
        return sessions[sessionToken].session;
      }
    }
    return null;
  },

  deleteSessionObjById(sessionToken) {
    Object.keys(this._stateInfoMap).forEach((type) => {
      let sessions = this._stateInfoMap[type].sessions;
      let sessionInfo = sessions[sessionToken];
      if (sessionInfo) {
        let channels = sessionInfo.channels;
        Object.keys(channels).forEach((channelToken) => {
          this.deleteChannelObjByToken(channelToken, sessionToken);
        });
        delete sessionInfo.session;
      }
    });
  },

  addChannelObj(channelObj, channelInfo) {
    Object.keys(this._stateInfoMap).forEach((type) => {
      let sessions = this._stateInfoMap[type].sessions;
      let sessionInfo = sessions[channelInfo.sessionToken];
      if (sessionInfo) {
        sessionInfo.channels[channelInfo.channelToken] = channelObj;
      }
    });
  },

  getChannelObjByToken(channelToken) {
    let keys = Object.keys(this._stateInfoMap);
    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      let sessions = this._stateInfoMap[key].sessions;
      let sessionKeys = Object.keys(sessions);
      for (let j = 0; j < sessionKeys.length; j++) {
        let sessionKey = sessionKeys[j];
        return sessions[sessionKey].channels[channelToken];
      }
    }
    return null;
  },

  deleteChannelObjByToken(channelToken, sessionToken) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      let sessionInfo = sessions[sessionToken];
      if (sessionInfo) {
        delete sessionInfo.channels[channelToken];
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

  createSEPromise: function createSEPromise(aCallback) {
    return this.createPromise((aResolve, aReject) => {
      let resolverId = this.getPromiseResolverId({
        resolve: aResolve,
        reject: aReject
      });
      aCallback(resolverId);
    });
  },

  rejectWithSEError: function rejectWithSEError(aReason) {
    return this.createSEPromise((aResolverId) => {
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
 * Readers can be physical devices or virtual devices.
 */
function SEReader() {}

SEReader.prototype = {
  _window: null,

  type: SE.TYPE_UICC,

  classID: Components.ID("{1c7bdba3-cd35-4f8b-a546-55b3232457d5}"),
  contractID: "@mozilla.org/secureelement/SEReader;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(win, type) {
    this._window = win;
    this._isSEPresent = true;
    this.type = type;
  },

  openSession: function openSession() {
    if (!this._isSEPresent) {
      return PromiseHelpers.rejectWithSEError(
        SE.ERROR_GENERIC + " SecureElement : '" + this.type +
        "' is not present. Unable to open the Session!");
    }

    return PromiseHelpers.createSEPromise((aResolverId) => {
      /**
       * @params for 'SE:OpenSession'
       *
       * resolverId  : ID that identifies this IPC request.
       * type        : Type identifying the session instance ('uicc' / 'eSE')
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:OpenSession", {
        resolverId: aResolverId,
        type: this.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  closeAll: function closeAll() {
    return PromiseHelpers.createSEPromise((aResolverId) => {
      /**
       * @params for 'SE:CloseAllByReader'
       *
       * resolverId  : ID that identifies this IPC request.
       * type        : Type identifying the session instance ('uicc' / 'eSE')
       * appId       : Current appId obtained from 'Principal' obj
       */
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
function SESession() {}

SESession.prototype = {
  _window: null,

  _aid: null,

  _sessionToken: null,

  reader: null,

  classID: Components.ID("{2b1809f8-17bd-4947-abd7-bdef1498561c}"),
  contractID: "@mozilla.org/secureelement/SESession;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(win, sessionToken, type) {
    this._window = win;
    // Update the 'sessionToken' that identifies and represents this
    // instance of the object
    this._sessionToken = sessionToken;
    this.reader = SEStateHelper.getReaderObjByType(type);
  },

  openLogicalChannel: function openLogicalChannel(aid) {
    this._checkClosed();

    if (!aid) {
      // According to SIMalliance_OpenMobileAPI v4 spec,
      // in case of UICC it is recommended to reject the opening of the logical
      // channel without a specific AID.
      if (this.reader.type === SE.TYPE_UICC) {
        return PromiseHelpers.rejectWithSEError(SE.ERROR_GENERIC +
                                                " AID is not specified!");
      }
    } else if (aid.length < SE.MIN_AID_LEN || aid.length > SE.MAX_AID_LEN) {
      return PromiseHelpers.rejectWithSEError(SE.ERROR_GENERIC +
            " Invalid AID length - " + aid.length);
    } else {
      // copy the aid
      this._aid = aid.subarray(0);
    }

    return PromiseHelpers.createSEPromise((aResolverId) => {
      /**
       * @params for 'SE:OpenChannel'
       *
       * resolverId  : ID that identifies this IPC request.
       * aid         : AID that identifies the applet on SecureElement
       * sessionToken: ID that identifies the current ongoing session that
                       this channel belongs to.
       * type        : Reader type ('uicc' / 'eSE')
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:OpenChannel", {
        resolverId: aResolverId,
        aid: this._aid,
        sessionToken: this._sessionToken,
        type: this.reader.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  closeAll: function closeAll() {
    this._checkClosed();
    return PromiseHelpers.createSEPromise((aResolverId) => {
      /**
       * @params for 'SE:CloseAllBySession'
       *
       * resolverId  : ID that identifies this IPC request.
       * sessionToken: ID that identifies the current ongoing session that
                       this channel belongs to.
       * type        : Reader type ('uicc' / 'eSE')
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:CloseAllBySession", {
        resolverId: aResolverId,
        sessionToken: this._sessionToken,
        type: this.reader.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  get isClosed() {
    return !SEStateHelper.getSessionObjById(this._sessionToken) ? true : false;
  },

  _checkClosed: function _checkClosed() {
    if (this.isClosed) {
      throw new Error(SE.ERROR_BADSTATE + " Session Already Closed!");
    }
  }
};

/**
 * Instance of 'SEChannel' object represent an ISO/IEC 7816-4 specification
 * channel opened to a secure element. It can be either a logical channel
 * or basic channel.
 */
function SEChannel() {}

SEChannel.prototype = {
  _window: null,

  _channelToken: null,

  _channelType: SE.TYPE_BASIC_CHANNEL,

  _aid: null,

  _sessionToken: null,

  session: null,

  openResponse: null,

  classID: Components.ID("{181ebcf4-5164-4e28-99f2-877ec6fa83b9}"),
  contractID: "@mozilla.org/secureelement/SEChannel;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(win, channelToken, isBasicChannel,
                                  openResponse, sessionToken, aid) {
    this._window = win;
    // Update the 'channel token' that identifies and represents this
    // instance of the object
    this._channelToken = channelToken;
    this._channelType = isBasicChannel ? SE.TYPE_BASIC_CHANNEL :
                                         SE.TYPE_LOGICAL_CHANNEL;
    this.openResponse = Cu.cloneInto(new Uint8Array(openResponse), win);
    this._sessionToken = sessionToken;
    this._aid = aid;
    // Update 'session' obj
    this.session = SEStateHelper.getSessionObjById(sessionToken);
  },

  transmit: function transmit(command) {
    this._checkClosed();

    let dataLen = command.data ? command.data.length : 0;
    if ((SE.APDU_HEADER_LEN + dataLen) > SE.MAX_APDU_LEN) {
      return PromiseHelpers.rejectWithSEError(SE.ERROR_GENERIC +
             " Command length exceeds max limit - 255. " +
             " Extended APDU is not supported!");
    }

    let commandAPDU = {
      cla: command.cla,
      ins: command.ins,
      p1: command.p1,
      p2: command.p2,
      data: command.data || null,
      le: command.le
    };

    return PromiseHelpers.createSEPromise((aResolverId) => {
      /**
       * @params for 'SE:TransmitAPDU'
       *
       * resolverId  : ID that identifies this IPC request.
       * apdu        : Object that wraps SECommand parameters
       * type        : Reader type ('uicc' / 'eSE')
       * sessionToken: ID that identifies the current ongoing session that
                       this channel belongs to.
       * channelToken: Token that identifies the current channel over which
                       'c-apdu' is being sent.
       * aid         : AID that identifies the applet on SecureElement
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:TransmitAPDU", {
        resolverId: aResolverId,
        apdu: commandAPDU,
        type: this.session.reader.type,
        sessionToken: this._sessionToken,
        channelToken: this._channelToken,
        aid: this._aid,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  close: function close() {
    this._checkClosed();
    return PromiseHelpers.createSEPromise((aResolverId) => {
      /**
       * @params for 'SE:CloseChannel'
       *
       * resolverId  : ID that identifies this IPC request.
       * type        : Reader type ('uicc' / 'eSE')
       * sessionToken: ID that identifies the current ongoing session that
                       this channel belongs to.
       * channelToken: Token that identifies the current channel over which
                       'c-apdu' is being sent.
       * aid         : AID that identifies the applet on SecureElement
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:CloseChannel", {
        resolverId: aResolverId,
        type: this.session.reader.type,
        sessionToken: this._sessionToken,
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

  _checkClosed: function _checkClosed() {
    if (this.isClosed) {
      throw new Error(SE.ERROR_BADSTATE +" Channel Already Closed!");
    }
  }
};

/**
 * Instance of 'SECommand' dom object represent C-APDU to be sent to a
 * secure element.
 */
function SECommand() {}

SECommand.prototype = {
  cla: 0x00,

  ins: 0x00,

  p1: 0xFF,

  p2: 0xFF,

  data: null,

  le: -1,

  classID: Components.ID("{cb8ccb1c-0e99-4a62-bf7d-11acc13848e0}"),
  contractID: "@mozilla.org/secureelement/SECommand;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports]),

  __init: function __init(cla, ins, p1, p2, data, le) {
    this.cla = cla;
    this.ins = ins;
    this.p1 = p1;
    this.p2 = p2;
    this.data = data;
    this.le = le;
  },
};

/**
 * Instance of 'SEResponse' object represent APDU response received
 * from a secure element.
 */
function SEResponse() {}

SEResponse.prototype = {
  sw1: 0x00,

  sw2: 0x00,

  data: null,

  channel: null,

  classID: Components.ID("{58bc6c7b-686c-47cc-8867-578a6ed23f4e}"),
  contractID: "@mozilla.org/secureelement/SEResponse;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(sw1, sw2, response, channelToken) {
    // Update the status bytes
    this.sw1 = sw1;
    this.sw2 = sw2;
    this.data = response ? response.slice(0) : null;
    // Update the channel obj
    this.channel = SEStateHelper.getChannelObjByToken(channelToken);
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
  contractID: "@mozilla.org/secureelement/SEManager;1",
  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsIDOMGlobalPropertyInitializer,
    Ci.nsISupportsWeakReference,
    Ci.nsIObserver
  ]),

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

  // This function will be called from DOMRequestIPCHelper.
  uninit: function uninit() {
    let self = this;
    // All requests that are still pending need to be invalidated
    // because the context is no longer valid.
    this.forEachPromiseResolver(function(k) {
      self.takePromiseResolver(k).reject("Window Context got destroyed!");
    });
    SEStateHelper.stateInfoMap = {};
    PromiseHelpers = null;
    this._window = null;
  },

  getSEReaders: function getSEReaders() {
    return PromiseHelpers.createSEPromise((aResolverId) => {
      /**
       * @params for 'SE:GetSEReaders'
       *
       * resolverId  : ID that identifies this IPC request.
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:GetSEReaders", {
        resolverId: aResolverId,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  receiveMessage: function(aMessage) {
    let result = aMessage.data.result;
    let data = aMessage.data.metadata;
    let chromeObj = null;
    let contentObj = null;
    let resolver = null;
    debug("receiveMessage(): " + aMessage.name);

    if (data) {
      resolver = PromiseHelpers.takePromiseResolver(data.resolverId);
      if (!resolver) {
        return;
      }
    }

    switch (aMessage.name) {
      case "SE:GetSEReadersResolved":
        let readers = [];
        for (let i = 0; i < result.readerTypes.length; i++) {
          chromeObj = new SEReader();
          chromeObj.initialize(this._window, result.readerTypes[i]);
          contentObj = this._window.SEReader._create(this._window, chromeObj);
          readers.push(contentObj);
        }
        SEStateHelper.addReaderObjs(readers);
        resolver.resolve(readers);
        break;
      case "SE:OpenSessionResolved":
        chromeObj = new SESession();
        chromeObj.initialize(this._window, result.sessionToken, data.type);
        contentObj = this._window.SESession._create(this._window, chromeObj);
        SEStateHelper.addSessionObj(contentObj, {
          sessionToken: result.sessionToken,
          type: data.type
        });
        resolver.resolve(contentObj);
        break;
      case "SE:OpenChannelResolved":
        chromeObj = new SEChannel();
        chromeObj.initialize(this._window,
                             result.channelToken,
                             result.isBasicChannel,
                             result.openResponse,
                             data.sessionToken,
                             data.aid);
        contentObj = this._window.SEChannel._create(this._window, chromeObj);
        SEStateHelper.addChannelObj(contentObj, {
          channelToken: result.channelToken,
          basicChannel: result.isBasicChannel,
          sessionToken: data.sessionToken,
          aid: data.aid
        });
        resolver.resolve(contentObj);
        break;
      case "SE:TransmitAPDUResolved":
        chromeObj = new SEResponse();
        chromeObj.initialize(result.sw1, result.sw2, result.response,
                             data.channelToken);
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
        SEStateHelper.deleteSessionObjById(data.sessionToken);
        resolver.resolve();
        break;
      case "SE:CloseChannelResolved":
        // Clear the state in SEStateHelper obj
        SEStateHelper.deleteChannelObjByToken(data.channelToken,
                                              data.sessionToken);
        resolver.resolve();
        break;
      case "SE:GetSEReadersRejected":
      case "SE:OpenSessionRejected":
      case "SE:OpenChannelRejected":
      case "SE:CloseChannelRejected":
      case "SE:TransmitAPDURejected":
      case "SE:CloseAllByReaderRejected":
      case "SE:CloseAllBySessionRejected":
        let error = data.error || SE.ERROR_GENERIC;
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
