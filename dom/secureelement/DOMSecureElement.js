/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2014, Deutsche Telekom, Inc. */

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

function PromiseHelpersSubclass(win) {
  this._window = win;
}

PromiseHelpersSubclass.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  _window: null,

  _context: [],

  createSEPromise: function createSEPromise(aCallback) {
    return this.createPromise((aResolve, aReject) => {
      let resolverId = this.getPromiseResolverId({
        resolve: aResolve,
        reject: aReject
      });
      aCallback(resolverId);
    });
  },

  createSEPromiseWithCtx: function createSEPromiseWithCtx(ctx, aCallback) {
    return this.createPromise((aResolve, aReject) => {
      let resolverId = this.getPromiseResolverId({
        resolve: aResolve,
        reject: aReject
      });
      // Before calling the callback, save the context
      this._context[resolverId] = ctx;
      aCallback(resolverId);
    });
  },

  takePromise: function takePromise(resolverId) {
    let resolver = this.takePromiseResolver(resolverId);
    if (!resolver) {
      return;
    }
    // Get the context associated with this resolverId
    let context = this._context[resolverId];
    delete this._context[resolverId];

    return {resolver: resolver, context: context};
  },

  rejectWithSEError: function rejectWithSEError(aReason) {
    return this.createSEPromise((aResolverId) => {
      debug("rejectWithSEError : " + aReason);
      this.takePromiseResolver(aResolverId).reject(new Error(aReason));
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

  _sessions: [],

  type: null,

  classID: Components.ID("{1c7bdba3-cd35-4f8b-a546-55b3232457d5}"),
  contractID: "@mozilla.org/secureelement/reader;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  // Chrome-only function
  onSessionClose: function onSessionClose(sessionContext) {
    let index = this._sessions.indexOf(sessionContext);
    if (index != -1) {
      this._sessions.splice(index, 1);
    }
  },

  initialize: function initialize(win, type) {
    this._window = win;
    this.type = type;
  },

  openSession: function openSession() {
    return PromiseHelpers.createSEPromise((aResolverId) => {
      let chromeObj = new SESession();
      chromeObj.initialize(this._window, this);
      let contentObj = this._window.SESession._create(this._window, chromeObj);
      this._sessions.push(contentObj);
      PromiseHelpers.takePromiseResolver(aResolverId).resolve(contentObj);
    });
  },

  closeAll: function closeAll() {
    return PromiseHelpers.createSEPromise((aResolverId) => {
      let promises = [];
      // Notify all children
      for (let session of this._sessions) {
        promises.push(session.closeAll());
      }
      let resolver = PromiseHelpers.takePromiseResolver(aResolverId);
      // Wait till all the promises are resolved
      Promise.all([promises]).then(function resolved() {
        this._sessions = [];
        resolver.resolve();
      }.bind(this), function rejected(reason) {
        resolver.reject(new Error(SE.ERROR_BADSTATE +
          " Unable to close all channels associated with this reader"));
      });
    });
  },

  get isSEPresent() {
    // TODO: Bug 1119152 - Implement new idl with interfaces to detect
    //                     secureelement state changes.
    return true;
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

  _channels: [],

  _isClosed: false,

  _reader: null,

  classID: Components.ID("{2b1809f8-17bd-4947-abd7-bdef1498561c}"),
  contractID: "@mozilla.org/secureelement/session;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  // Private function
  _checkClosed: function _checkClosed() {
    if (this._isClosed) {
      throw new Error(SE.ERROR_BADSTATE + " Session Already Closed!");
    }
  },

  // Chrome-only function
  onChannelOpen: function onChannelOpen(channelContext) {
    this._channels.push(channelContext);
  },

  // Chrome-only function
  onChannelClose: function onChannelClose(channelContext) {
    let index = this._channels.indexOf(channelContext);
    if (index != -1) {
      this._channels.splice(index, 1);
    }
  },

  initialize: function initialize(win, readerCtx) {
    this._window = win;
    this._reader = readerCtx;
  },

  openLogicalChannel: function openLogicalChannel(aid) {
    this._checkClosed();

    if (!aid) {
      // According to SIMalliance_OpenMobileAPI v4 spec, if the aid is null
      // (in case of UICC) it is recommended to reject the opening of the logical
      // channel without a specific AID.
      if (this.reader.type === SE.TYPE_UICC) {
        return PromiseHelpers.rejectWithSEError(SE.ERROR_GENERIC +
               " AID is not specified!");
      }
    } else if (aid.length < SE.MIN_AID_LEN || aid.length > SE.MAX_AID_LEN) {
      return PromiseHelpers.rejectWithSEError(SE.ERROR_GENERIC +
             " Invalid AID length - " + aid.length);
    }

    return PromiseHelpers.createSEPromiseWithCtx(this, (aResolverId) => {
      /**
       * @params for 'SE:OpenChannel'
       *
       * resolverId  : ID that identifies this IPC request.
       * aid         : AID that identifies the applet on SecureElement
       * type        : Reader type ('uicc' / 'eSE')
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:OpenChannel", {
        resolverId: aResolverId,
        aid: aid,
        type: this.reader.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  closeAll: function closeAll() {
    this._checkClosed();

    return PromiseHelpers.createSEPromise((aResolverId) => {
      let promises = [];
      // Notify all children
      for (let channel of this._channels) {
        promises.push(channel.close());
      }
      let resolver = PromiseHelpers.takePromiseResolver(aResolverId);
      // Wait till all the promises are resolved
      Promise.all([promises]).then(function resolved() {
        // Since all its children (channels) are closed,
        // update self 'isClosed = true' and reset all the channel instances
        this._isClosed = true;
        this._channels = [];
        // Notify parent of this session instance's closure, so that its
        // instance entry can be removed from the parent as well.
        this._reader.onSessionClose(this.__DOM_IMPL__);
        resolver.resolve();
      }.bind(this), function rejected(reason) {
        resolver.reject(new Error(SE.ERROR_BADSTATE +
          " Unable to close all channels associated with this session"));
      });
    });
  },

  get reader() {
    return this._reader.__DOM_IMPL__;
  },

  get isClosed() {
    return this._isClosed;
  },

  set isClosed(isClosed) {
    this._isClosed = isClosed;
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

  _isClosed: false,

  _session: null,

  openResponse: [],

  type: null,

  classID: Components.ID("{181ebcf4-5164-4e28-99f2-877ec6fa83b9}"),
  contractID: "@mozilla.org/secureelement/channel;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  // Private function
  _checkClosed: function _checkClosed() {
    if (this._isClosed) {
      throw new Error(SE.ERROR_BADSTATE + " Channel Already Closed!");
    }
  },

  // Chrome-only function
  onClose: function onClose() {
    this._isClosed = true;
    // Notify the parent
    this._session.onChannelClose(this.__DOM_IMPL__);
  },

  initialize: function initialize(win, channelToken, isBasicChannel,
                                  openResponse, sessionCtx) {
    this._window = win;
    // Update the 'channel token' that identifies and represents this
    // instance of the object
    this._channelToken = channelToken;
    // Update 'session' obj
    this._session = sessionCtx;
    this.openResponse = Cu.cloneInto(new Uint8Array(openResponse), win);
    this.type = isBasicChannel ? "basic" : "logical";
  },

  transmit: function transmit(command) {
    this._checkClosed();

    let dataLen = command.data ? command.data.length : 0;
    if ((SE.APDU_HEADER_LEN + dataLen) > SE.MAX_APDU_LEN) {
      return PromiseHelpers.rejectWithSEError(SE.ERROR_GENERIC +
             " Command length exceeds max limit - 255. " +
             " Extended APDU is not supported!");
    }

    if ((command.cla & 0x80 === 0) && ((command.cla & 0x60) !== 0x20)) {
      if (ins === SE.INS_MANAGE_CHANNEL) {
        return PromiseHelpers.rejectWithSEError(SE.ERROR_SECURITY +
               ", MANAGE CHANNEL command not permitted");
      }
      if ((command.ins === SE.INS_SELECT) && (command.p1 == 0x04)) {
	// SELECT by DF Name (p1=04) is not allowed
        return PromiseHelpers.rejectWithSEError(SE.ERROR_SECURITY +
               ", SELECT command not permitted");
	throw new Error(SE.ERROR_SECURITY);
      }
      debug("Attempting to transmit an ISO command");
    } else {
      debug("Attempting to transmit GlobalPlatform command");
    }

    let commandAPDU = {
      cla: command.cla,
      ins: command.ins,
      p1: command.p1,
      p2: command.p2,
      data: command.data,
      le: command.le
    };

    return PromiseHelpers.createSEPromiseWithCtx(this, (aResolverId) => {
      /**
       * @params for 'SE:TransmitAPDU'
       *
       * resolverId  : ID that identifies this IPC request.
       * apdu        : Object that wraps SECommand parameters
       * type        : Reader type ('uicc' / 'eSE')
       * channelToken: Token that identifies the current channel over which
                       'c-apdu' is being sent.
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:TransmitAPDU", {
        resolverId: aResolverId,
        apdu: commandAPDU,
        type: this.session.reader.type,
        channelToken: this._channelToken,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  close: function close() {
    this._checkClosed();

    return PromiseHelpers.createSEPromiseWithCtx(this, (aResolverId) => {
      /**
       * @params for 'SE:CloseChannel'
       *
       * resolverId  : ID that identifies this IPC request.
       * type        : Reader type ('uicc' / 'eSE')
       * channelToken: Token that identifies the current channel over which
                       'c-apdu' is being sent.
       * appId       : Current appId obtained from 'Principal' obj
       */
      cpmm.sendAsyncMessage("SE:CloseChannel", {
        resolverId: aResolverId,
        type: this.session.reader.type,
        channelToken: this._channelToken,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  get session() {
    return this._session.__DOM_IMPL__;
  },

  get isClosed() {
    return this._isClosed;
  },

  set isClosed(isClosed) {
    this._isClosed = isClosed;
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
  contractID: "@mozilla.org/secureelement/command;1",
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

  _channel: null,

  classID: Components.ID("{58bc6c7b-686c-47cc-8867-578a6ed23f4e}"),
  contractID: "@mozilla.org/secureelement/response;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  initialize: function initialize(sw1, sw2, response, channelCtx) {
    // Update the status bytes
    this.sw1 = sw1;
    this.sw2 = sw2;
    this.data = response ? response.slice(0) : null;
    // Update the channel obj
    this._channel = channelCtx;
  },

  get channel() {
    return this._channel.__DOM_IMPL__;
  }
};

/**
 * SEManager
 */
function SEManager() {}

SEManager.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  _window: null,

  classID: Components.ID("{4a8b6ec0-4674-11e4-916c-0800200c9a66}"),
  contractID: "@mozilla.org/secureelement/manager;1",
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
                      "SE:OpenChannelResolved",
                      "SE:CloseChannelResolved",
                      "SE:TransmitAPDUResolved",
                      "SE:GetSEReadersRejected",
                      "SE:OpenChannelRejected",
                      "SE:CloseChannelRejected",
                      "SE:TransmitAPDURejected"];

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

  receiveMessage: function receiveMessage(message) {
    let result = message.data.result;
    let data = message.data.metadata;
    let chromeObj = null;
    let contentObj = null;
    let resolver = null;
    let context = null;

    let promiseResolver = PromiseHelpers.takePromise(data.resolverId);
    if (promiseResolver) {
      resolver = promiseResolver.resolver;
      // This 'context' is the instance that originated this IPC message.
      context = promiseResolver.context;
    }

    if (DEBUG) debug("receiveMessage(): " + message.name);
    switch (message.name) {
      case "SE:GetSEReadersResolved":
        let readers = [];
        for (let i = 0; i < result.readerTypes.length; i++) {
          chromeObj = new SEReader();
          chromeObj.initialize(this._window, result.readerTypes[i]);
          contentObj = this._window.SEReader._create(this._window, chromeObj);
          readers.push(contentObj);
        }
        resolver.resolve(readers);
        break;
      case "SE:OpenChannelResolved":
        chromeObj = new SEChannel();
        chromeObj.initialize(this._window,
                             result.channelToken,
                             result.isBasicChannel,
                             result.openResponse,
                             context);
        contentObj = this._window.SEChannel._create(this._window, chromeObj);
        if (context) {
          // Notify context's handler with SEChannel instance
          context.onChannelOpen(contentObj);
        }
        resolver.resolve(contentObj);
        break;
      case "SE:TransmitAPDUResolved":
        chromeObj = new SEResponse();
        chromeObj.initialize(result.sw1,
                             result.sw2,
                             result.response,
                             context);
        contentObj = this._window.SEResponse._create(this._window, chromeObj);
        resolver.resolve(contentObj);
        break;
      case "SE:CloseChannelResolved":
        if (context) {
          // Notify context's onClose handler
          context.onClose();
        }
        resolver.resolve();
        break;
      case "SE:GetSEReadersRejected":
      case "SE:OpenChannelRejected":
      case "SE:CloseChannelRejected":
      case "SE:TransmitAPDURejected":
        let error = data.error || SE.ERROR_GENERIC;
        resolver.reject(error);
        break;
      default:
        debug("Could not find a handler for " + message.name);
        resolver.reject();
        break;
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([
  SECommand, SEResponse, SEChannel, SESession, SEReader, SEManager
]);
