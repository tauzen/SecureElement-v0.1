/* Copyright 2012 Mozilla Foundation and Mozilla contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* Copyright © 2014, Deutsche Telekom, Inc. */

"use strict";

/* globals Components, XPCOMUtils, SE, dump, libcutils, Services,
   iccProvider, SEUtils */

const { interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/systemlibs.js");

XPCOMUtils.defineLazyGetter(this, "SE", function() {
  let obj = {};
  Cu.import("resource://gre/modules/se_consts.js", obj);
  return obj;
});

// set to true in se_consts.js to see debug messages
let DEBUG = SE.DEBUG_CONNECTOR;
function debug(s) {
  if (DEBUG) {
    dump("-*- UiccConnector: " + s + "\n");
  }
}

XPCOMUtils.defineLazyModuleGetter(this, "SEUtils",
                                  "resource://gre/modules/SEUtils.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "iccProvider",
                                   "@mozilla.org/ril/content-helper;1",
                                   "nsIIccProvider");

const UICCCONNECTOR_CONTRACTID =
  "@mozilla.org/secureelement/connector;1";
const UICCCONNECTOR_CID =
  Components.ID("{8e040e5d-c8c3-4c1b-ac82-c00d25d8c4a4}");
const NS_XPCOM_SHUTDOWN_OBSERVER_ID = "xpcom-shutdown";

const PREFERRED_UICC_CLIENTID =
  libcutils.property_get("ro.moz.se.def_client_id", "0");

/**
 * 'UiccConnector' object is a wrapper over iccProvider's channel management
 * related interfaces that implements nsISecureElementConnector interface.
 */
function UiccConnector() {
  this._init();
}

UiccConnector.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISecureElementConnector]),
  classID: UICCCONNECTOR_CID,
  classInfo: XPCOMUtils.generateCI({
    classID: UICCCONNECTOR_CID,
    contractID: UICCCONNECTOR_CONTRACTID,
    classDescription: "UiccConnector",
    interfaces: [Ci.nsISecureElementConnector,
                 Ci.nsIIccListener,
                 Ci.nsIObserver]
  }),

  _isPresent: false,

  _init: function() {
    Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
    iccProvider.registerIccMsg(PREFERRED_UICC_CLIENTID, this);

    // Update the state in order to avoid race condition.
    // By this time, 'notifyCardStateChanged (with proper card state)'
    // may have occurred already before this module initialization.
    this._updatePresenceState();
  },

  _shutdown: function() {
    Services.obs.removeObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
    iccProvider.unregisterIccMsg(PREFERRED_UICC_CLIENTID, this);
  },

  _updatePresenceState: function() {
    // Consider following Card states as not quite ready for performing
    // IccChannel* related commands
    let notReadyStates = [
      "unknown",
      "illegal",
      "personalizationInProgress",
      "permanentBlocked",
    ];
    let cardState = iccProvider.getCardState(PREFERRED_UICC_CLIENTID);
    this._isPresent = cardState !== null &&
      notReadyStates.indexOf(cardState) == -1;
  },

  _checkPresence: function() {
    return this._isPresent;
  },

  _setChannelToClassByte(cla, channel) {
    if (channel < 4) {
      // b7 = 0 indicates the first interindustry class byte coding
      cla = (((cla & 0x9C) & 0xFF) |  channel);
    } else if (channel < 20) {
      // b7 = 1 indicates the further interindustry class byte coding
      cla = (((cla & 0xB0) & 0xFF) | 0x40 | (channel - 4));
    } else {
      debug("Channel number must be within [0..19]");
      return SE.ERROR_GENERIC;
    }
    return cla;
  },

  _getChannelNumber: function(cla) {
    // As per GlobalPlatform Card Specification v2.2, check the 7th bit
    let classByteCoding = (cla & 0x40);
    if (classByteCoding === 0x00) {
      // If 7 th bit is not set, then channel number is encoded in the 2 
      // rightmost bits Refer to section 11.1.4.1. Possible logical channel 
      // are: (00: 0, 01 : 1, 10 : 2, 11 : 3)
      return cla & 0x03;
    } else {
      // If the 7th bit is set, channel number is encoded in the 4 rightmost
      // bits, refer to section 11.1.4.2. Note that Supplementary Logical
      // Channels start from 4 to 19. So add 4!
      return (cla & 0x0F) + 4;
    }
  },

  _doGetOpenResponse: function(clientId, channel, length, callback) {
    // Le value is set. It means that this is a request for all available
    // response bytes.
    this.exchangeAPDU(clientId, channel, (channel & 0xFF), SE.INS_GET_RESPONSE,
                        0x00, 0x00, null, length, {
      notifyExchangeAPDUResponse: function(sw1, sw2, response) {
        debug("GET Response : " + response);
        if (callback) {
          callback({
            error: SE.ERROR_NONE,
            sw1: sw1,
            sw2: sw2,
            response: response
          });
        }
      },

      notifyError: function(reason) {
        debug("Failed to get open response: " + 
              ", Rejected with Reason : " + reason);
        if (callback) {
          callback({ error: SE.ERROR_INVALIDAPPLICATION, reason: reason });
        }
      }
    });
  },

  _doIccExchangeAPDU: function(clientId, channel, cla, ins, p1, p2, p3,
                               data, appendResponse, callback) {
    iccProvider.iccExchangeAPDU(clientId, channel, (cla & 0xFC), ins,
                                p1, p2, p3, data, {
      notifyExchangeAPDUResponse: (sw1, sw2, response) => {
        debug("sw1 : " + sw1 + ", sw2 : " + sw2 + ", response : " + response);

        // According to ETSI TS 102 221 , Section 7.2.2.3.1,
        // Enforce 'Procedure bytes' checks before notifying the callback. 
        // Note that 'Procedure bytes'are special cases.
        // There is no need to handle '0x60' procedure byte as it implies
        // no-action from SE stack perspective. This procedure byte is not
        // notified to application layer (?).
        if (sw1 === 0x6C) {
          // Use the previous command header with length as second procedure
          // byte (SW2) as received and repeat the procedure.
          debug("Enforce '0x6C' Procedure with sw2 : " + sw2);

          // Recursive! and Pass empty response '' as args, since '0x6C'
          // procedure does not have to deal with appended responses.
          this._doIccExchangeAPDU(clientId, channel, cla, ins, p1, p2,
                                  sw2, data, "", callback);
        } else if (sw1 === 0x61) {
          debug("Enforce '0x61' Procedure with sw2 : " + sw2);
          // Since the terminal waited for a second procedure byte and
          // received it (sw2), send a GET RESPONSE command header to the UICC
          // with a maximum length of 'XX', where 'XX' is the value of the 
          // second procedure byte (SW2).

          // Recursive, with GET RESPONSE bytes and '0x61' procedure IS 
          // interested in appended responses.
          // Pass appended response and note that p3=sw2.
          this._doIccExchangeAPDU(clientId, channel, (channel & 0xFF),
            SE.INS_GET_RESPONSE, 0x00, 0x00, sw2, null,
            (response ? response + appendResponse : appendResponse),
            callback);
        } else if (callback) {
          callback.notifyExchangeAPDUResponse(sw1, sw2, response);
        }
      },

      notifyError: (reason) => {
        debug("Failed to trasmit C-APDU over the channel #  : " + channel +
              ", Rejected with Reason : " + reason);
        if (callback) {
          callback.notifyError(reason);
        }
      }
    });
  },

  /**
   * nsISecureElementConnector interface methods.
   */

  /**
   * Opens a supplementary channel on a given clientId
   *
   * @param clientId
   *        ClientId representing a UICC / SIM slot
   * @param aid
   *        Application Identifier identifying the applet on the card.
   * @param callback
   *        Callback interface that implements 'nsISEChannelCallback'.
   *        The result will be notified either through
   *        'notifyOpenChannelSuccess(channel, openResponse)' (or)
   *        'notifyError(error)'.
   */
  openChannel: function(clientId, aid, callback) {
    this._checkPresence();

    // TODO: Bug 1118106 : Handle Resource management / leaks by persisting
    //                     the newly opened channel in some persistent
    //                     storage so that when this module gets restarted
    //                     (say after opening a channel) in the event of
    //                     some erroneous conditions such as gecko restart /,
    //                     crash it can read the persistent storage to check
    //                     if there are any held resources. (opened channels)
    //                     and close them.
    iccProvider.iccOpenChannel(clientId, aid, {
      notifyOpenChannelSuccess: (channel) => {
        this._doGetOpenResponse(clientId, channel, 0x00, function(result) {
          if (callback) {
            callback.notifyOpenChannelSuccess(channel, result.response);
          }
        });
      },

      notifyError: (reason) => {
        debug("Failed to open the channel to AID : " + aid +
              ", Rejected with Reason : " + reason);
        if (callback) {
          callback.notifyError(reason);
        }
      }
    });
  },

  /**
   * Transmit the C-APDU (command) on given clientId.
   */
  exchangeAPDU: function(clientId, channel, cla, ins, p1, p2, data, le, callback) {
    this._checkPresence();

    // See GP Spec, 11.1.4 Class Byte Coding
    cla = this._setChannelToClassByte(cla, channel);
    let appendLe = (data !== null) && (le !== -1);
    // Note that P3 of the C-TPDU is set to ‘00’ in Case 1
    // (only headers) scenarios
    let p3 = data ? data.length : (le !== -1 ? le : 0x00);
    let commandApduData = null;

    // Check p3 > 0 AND the command.data length > 0. The second condition is
    // needed to explicitly check if there are 'data bytes' indeed. If there
    // are no 'data bytes' then 'p3' will be interpreted as 'Le'.
    if ((p3 > 0) && (data.length > 0)) {
      commandApduData = new Uint8Array(p3);
      let offset = 0;
      while (offset < SE.MAX_APDU_LEN && offset < p3) {
        commandApduData[offset] = data[offset];
        offset++;
      }
    }
    if (commandApduData && appendLe) {
      // Append 'le' value to data
      let leHexStr = 
        SEUtils.byteArrayToHexString([le & 0xFF, (le >> 8) & 0xFF]);
      commandApduData += leHexStr;
    }
    
    // Pass empty response '' as args as we are not interested in appended
    // responses yet!
    debug("exchangeAPDU on Channel # " + channel);
    this._doIccExchangeAPDU(clientId, channel, cla, ins, 
                            p1, p2, p3/2, data, "", callback);
  },

  /**
   * Closes the channel on given clientId.
   */
  closeChannel: function(clientId, channel, callback) {
    this._checkPresence();

    iccProvider.iccCloseChannel(clientId, channel, {
      notifyCloseChannelSuccess: function() {
        debug("closeChannel successfully closed the channel # : " + channel);
        if (callback) {
          callback.notifyCloseChannelSuccess();
        }
      },

      notifyError: function(reason) {
        debug("Failed to close the channel #  : " + channel +
              ", Rejected with Reason : " + reason);
        if (callback) {
          callback.notifyError(reason);
        }
      }
    });
  },

  /**
   * nsIIccListener interface methods.
   */
  notifyStkCommand: function() {},

  notifyStkSessionEnd: function() {},

  notifyIccInfoChanged: function() {},

  notifyCardStateChanged: function() {
    this._updatePresenceState();
  },

  /**
   * nsIObserver interface methods.
   */

  observe: function(subject, topic, data) {
    if (topic === NS_XPCOM_SHUTDOWN_OBSERVER_ID) {
      this._shutdown();
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([UiccConnector]);
