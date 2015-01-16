/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2015, Deutsche Telekom, Inc. */

"use strict";

/* globals Components, dump, XPCOMUtils, Promise, Task, SEUtils, libcutils,
   UiccConnector */

let DEBUG = false;
function debug(msg) {
  if (DEBUG) {
    dump("-*- GPAccessRulesManager " + msg);
  }
}

const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/systemlibs.js");

XPCOMUtils.defineLazyServiceGetter(this, "UiccConnector",
                                   "@mozilla.org/secureelement/connector/uicc;1",
                                   "nsISecureElementConnector");

XPCOMUtils.defineLazyModuleGetter(this, "SEUtils",
                                  "resource://gre/modules/SEUtils.jsm");

/* Object Directory File (ODF) is an elementary file which contain
   pointers to other EFs. It is specified in PKCS#15 section 6.7. */
const ODF_DF = [0x50, 0x31];

/* ISO 7816-4: secure messaging */
const CLA_SM = 0x00;

/* ISO 7816-4, 5.4.1 table 11 */
const INS_SF = 0xA4; // select file
const INS_GR = 0xC0; // get response
const INS_RB = 0xB0; // read binary

/* ISO 7816-4: select file, see 6.11.3, table 58 & 59 */
const P1_SF_DF = 0x00; // select DF
const P2_SF_FCP = 0x04; // return FCP

/* ISO 7816-4: read binary, 6.1.3. P1 and P2 describe offset of the first byte
   to be read. We always read the whole files at the moment. */
const P1_RB = 0x00;
const P2_RB = 0x00;

/* ISO 7816-4: get response, 7.1.3 table 74 */
const P1_GR = 0x00;
const P2_GR = 0x00;

/*
 * Based on [1] - "GlobalPlatform Device Technology
 * Secure Element Access Control Version 1.0".
 * GPAccessRulesManager reads and parses access rules from SE file system
 * as defined in section #7 of [1]: "Structure of Access Rule Files (ARF)".
 * Rules retrieval from ARA-M applet is not implmented due to lack of
 * commercial implemenations of ARA-M.
 * @todo implement ARA-M support according to section #4 of [1]
 * @todo const used tags
 */
function GPAccessRulesManager() {}

GPAccessRulesManager.prototype = {
  // source [1] section 7.1.3 PKCS#15 Selection
  PKCS_AID: "a000000063504b43532d3135",

  // APDUs (ISO 7816-4) for accessing rules on SE file system
  // see for more details: http://www.cardwerk.com/smartcards/
  // smartcard_standard_ISO7816-4_6_basic_interindustry_commands.aspx
  READ_BINARY:   [CLA_SM, INS_RB, P1_RB, P2_RB],
  GET_RESPONSE:  [CLA_SM, INS_GR, P1_GR, P2_GR],
  SELECT_BY_DF:  [CLA_SM, INS_SF, P1_SF_DF, P2_SF_FCP],

  // Non-null if there is a channel open
  channel: null,

  // Refresh tag path in the acMain file as described in GPD spec,
  // sections 7.1.5 and C.1.
  REFRESH_TAG_PATH: [0x30, 0x04],
  refreshTag: null,

  // Contains rules as read from the SE
  rules: [],

  init: function init() {
    debug("init");

    return new Promise((resolve, reject) => {
      this._readAccessRules(resolve);
    });
  },

  getAccessRules: function getAccessRules() {
    debug("getAccessRules");

    return new Promise((resolve, reject) => {
      this._readAccessRules(() => resolve(this.rules));
    });
  },

  _readAccessRules: Task.async(function*(done) {
    try {
      yield this._openChannel();

      let odf = yield this._readODF();
      let dodf = yield this._readDODF(odf);

      let acmf = yield this._readACMF(dodf);
      let refreshTag = acmf[this.REFRESH_TAG_PATH[0]]
                           [this.REFRESH_TAG_PATH[1]];

      if (SEUtils.arraysEqual(this.refreshTag, refreshTag)) {
        debug("_readAccessRules: refresh tag equals to the one saved.");
        yield this._closeChannel();
        return done();
      }

      this.refreshTag = refreshTag;
      debug("_readAccessRules: refresh tag saved: " + this.refreshTag);

      let acrf = yield this._readACRules(acmf);
      let condFiles = yield this._readACConditions(acrf);
      this.rules = yield this._parseRules(acrf, condFiles);

      debug("_readAccessRules: done reading rules");
      DEBUG && debug("_readAccessRules: " + JSON.stringify(this.rules, 0, 2));

      yield this._closeChannel();
      done();
    } catch (error) {
      debug("Error: " + (error ? error.message : "undefined"));
      this.rules = [];
      yield this._closeChannel();
      done();
    }
  }),

  _openChannel: function _openChannel() {
    if (this.channel !== null) {
      debug("_openChannel: Channel already opened, rejecting.");
      return Promise.reject();
    }

    return new Promise((resolve, reject) => {
      UiccConnector.openChannel(this.PKCS_AID, {
        notifyOpenChannelSuccess: (channel, openResponse) => {
          debug("_openChannel/notifyOpenChannelSuccess: Channel " + channel +
                " opened, open response: " + openResponse);
          this.channel = channel;
          resolve();
        },
        notifyError: (error) => {
          debug("_openChannel/notifyError: failed to open channel, error: " +
                error);
          reject(error);
        }
      });
    });
  },

  _closeChannel: function _closeChannel() {
    if (this.channel === null) {
      debug("_closeChannel: Channel not opened, rejecting.");
      return Promise.reject();
    }

    return new Promise((resolve, reject) => {
      UiccConnector.closeChannel(this.channel, {
        notifyCloseChannelSuccess: () => {
          debug("_closeChannel/notifyCloseChannelSuccess: chanel " +
                this.channel + " closed");
          this.channel = null;
          resolve();
        },
        notifyError: (error) => {
          debug("_closeChannel/notifyError: error closing channel, error" +
                error);
          reject(error);
        }
      });
    });
  },

  _exchangeAPDU: function _exchangeAPDU(bytes) {
    if (this.channel === null) {
      debug("Channel not opened");
      return Promise.reject();
    }

    debug("apdu " + JSON.stringify(bytes));

    let apdu = this._bytesToAPDU(bytes);
    return new Promise((resolve, reject) => {
      UiccConnector.exchangeAPDU(this.channel, apdu.cla,
        apdu.ins, apdu.p1, apdu.p2, apdu.data, apdu.le,
        {
          notifyExchangeAPDUResponse: (sw1, sw2, data) => {
            debug("_exchangeAPDU/notifyExchangeAPDUResponse");
            debug("APDU response is " + sw1.toString(16) + sw2.toString(16) +
                  " data: " + data);

            if (sw1 !== 0x90 || sw2 !== 0x00) {
              debug("rejecting APDU response");
              reject();
              return;
            }

            resolve(this._parseTLV(data));
          },

          notifyError: (error) => {
            debug("_exchangeAPDU/notifyError " + error);
            reject(error);
          }
        }
      );
    });
  },

  _readBinaryFile: function _readBinaryFile(selectResponse) {
    DEBUG && debug("Select response: " + JSON.stringify(selectResponse));
    let fileLength = selectResponse[0x62][0x80];

    // If file is empty, no need to attempt to read it.
    if (fileLength[0] === 0 && fileLength[1] === 0) {
      return Promise.resolve(null);
    }

    // TODO READ BINARY with filelength not supported
    // let readApdu = this.READ_BINARY.concat(fileLength);
    return this._exchangeAPDU(this.READ_BINARY);
  },

  _selectAndRead: function _selectAndRead(df, cb) {
    return this._exchangeAPDU(this.SELECT_BY_DF.concat(df.length & 0xFF, df))
           .then((resp) => this._readBinaryFile(resp));
  },

  _readODF: function _readODF() {
    debug("_readODF");
    return this._selectAndRead(ODF_DF);
  },

  _readDODF: function _readDODF(odfFile) {
    debug("_readDODF, ODF file: " + odfFile);

    // Data Object Directory File (DODF) is used as an entry point to the
    // Access Control data. It is specified in PKCS#15 section 6.7.6.
    // DODF is referenced by the ODF file, which looks as follows:
    //   A7 06
    //      30 04
    //         04 02 XY WZ
    // where [0xXY, 0xWZ] is a DF of DODF file.
    let DODF_DF = odfFile[0xA7][0x30][0x04];
    return this._selectAndRead(DODF_DF);
  },

  _readACMF: function _readACMF(dodfFile) {
    debug("_readACMF, DODF file: " + dodfFile);

    // ACMF file DF is referenced in DODF file, which looks like this:
    //
    //  A1 29
    //     30 00
    //     30 0F
    //        0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C
    //     A1 14
    //        30 12
    //           06 0A 2A 86 48 86 FC 6B 81 48 01 01  <-- GPD registered OID
    //           30 04
    //              04 02 AB CD  <-- ACMF DF
    //  A1 2B
    //     30 00
    //     30 0F
    //        0C 0D 53 41 54 53 41 20 47 54 4F 20 31 2E 31
    //     A1 16
    //        30 14
    //           06 0C 2B 06 01 04 01 2A 02 6E 03 01 01 01  <-- some other OID
    //           30 04
    //              04 02 XY WZ  <-- some other file's DF
    //
    // DODF file consists of DataType's with oidDO entries. Entry with OID
    // equal to "1.2.840.114283.200.1.1" ("2A 86 48 86 FC 6B 81 48 01 01")
    // contains DF of the ACMF. In the file above, it means that ACMF DF
    // equals to [0xAB, 0xCD], and not [0xXY, 0xWZ].
    //
    // Algorithm used to encode OID to an byte array:
    //   http://www.snmpsharpnet.com/?p=153

    let gpdOid = [0x2A,                 // 1.2
                  0x86, 0x48,           // 840
                  0x86, 0xFC, 0x6B,     // 114283
                  0x81, 0x48,           // 129
                  0x01,                 // 1
                  0x01];                // 1

    let records = this._ensureIsArray(dodfFile[0xA1]);

    // Look for the OID registered for GPD SE.
    let gpdRecords = records.filter((record) => {
      let oid = record[0xA1][0x30][0x06];
      return SEUtils.arraysEqual(oid, gpdOid);
    });

    // [1] 7.1.5: "There shall be only one ACMF file per Secure Element.
    // If a Secure Element contains several ACMF files, then the security shall
    // be considered compromised and the Access Controlr enforcer shall forbid
    // access to all (...) apps."
    if (gpdRecords.length !== 1) {
      return Promise.reject(new Error(gpdRecords.length + " ACMF files found"));
    }

    let ACMain_DF = gpdRecords[0][0xA1][0x30][0x30][0x04];
    return this._selectAndRead(ACMain_DF);
  },

  _readACRules: function _readACRules(acMainFile) {
    debug("_readACRules, ACMain file: " + acMainFile);

    // ACMF looks like this:
    //
    //  30 10
    //    04 08 XX XX XX XX XX XX XX XX
    //    30 04
    //       04 02 XY WZ
    //
    // where [XY, WZ] is a DF of ACRF, and XX XX XX XX XX XX XX XX is a refresh
    // tag.

    let ACRules_DF = acMainFile[0x30][0x30][0x04];
    return this._selectAndRead(ACRules_DF);
  },

  _readACConditions: function _readACConditions(acRulesFile) {
    debug("_readACCondition, ACRules file: " + acRulesFile);

    let acRules = this._ensureIsArray(acRulesFile[0x30]);
    if (acRules.length === 0) {
      debug("No rules found in ACRules file.");
      return Promise.reject(new Error("No rules found in ACRules file"));
    }

    // We first read all the condition files referenced in the ACRules file,
    // because ACRules file might reference one ACCondition file more than
    // once. In that case it doesn't make sense to read the same ACCondtion
    // file twice, and since reading it isn't exactly fast, we optimize it
    // here.
    let acReadQueue = Promise.resolve({});
    acRules.forEach((ruleEntry) => {
      let df = ruleEntry[0x30][0x04];

      acReadQueue = acReadQueue.then((conditionFiles) => {
        if (conditionFiles[df] !== undefined) {
          return conditionFiles;
        }

        return this._selectAndRead(df)
               .then((conditionFileContents) => {
                 conditionFiles[df] = conditionFileContents;
                 return conditionFiles;
               });
      });
    });

    return acReadQueue;
  },

  _parseRules: function _parseRules(acRulesFile, conditionFiles) {
    DEBUG && debug("_parseRules: acRulesFile " + JSON.stringify(acRulesFile));
    DEBUG && debug("_parseRules: conditionFiles " + JSON.stringify(conditionFiles));
    let rules = [];

    let acRules = this._ensureIsArray(acRulesFile[0x30]);
    acRules.forEach((ruleEntry) => {
      DEBUG && debug("Parsing one rule: " + JSON.stringify(ruleEntry));
      let rule = {};

      let df = ruleEntry[0x30][0x04];
      let condition = conditionFiles[df];

      // 0xA0 and 0x82 tags as per GPD spec sections C.1 - C.3. 0xA0 means
      // that rule describes access to one SE applet only (and its AID is
      // given). 0x82 means that rule describes acccess to all SE applets.
      let oneApplet = ruleEntry[0xA0];
      let allApplets = ruleEntry[0x82];

      if (oneApplet) {
        rule.applet = oneApplet[0x04];
      } else if (allApplets) {
        rule.applet = Ci.nsIAccessRulesManager.ALL_APPLET;
      } else {
        throw Error("Unknown applet definition");
      }

      if (condition === null) {
        rule.application = Ci.nsIAccessRulesManager.DENY_ALL;
      } else if (condition[0x30]) {
        if (!Array.isArray(condition[0x30]) && !condition[0x30][0x04]) {
          rule.application = Ci.nsIAccessRulesManager.ALLOW_ALL;
        } else {
          rule.application = this._ensureIsArray(condition[0x30])
                             .map((conditionEntry) => {
            return conditionEntry[0x04];
          });
        }
      } else {
        throw Error("Unknown application definition");
      }

      DEBUG && debug("Rule parsed, adding to the list: " + JSON.stringify(rule));
      rules.push(rule);
    });

    DEBUG && debug("All rules parsed, we have those in total: " + JSON.stringify(rules));
    return rules;
  },

  _parseTLV: function _parseTLV(bytes) {
    // All tags will be treated as a simple TLV's
    // (i.e. with a plain value, not subject to further
    // unpacking), unless those tags are listed here
    let containerTags = [
      // ASN.1 sequence
      0x30,
      // File control parameters (FCP) - ISO 7816
      0x62,
      // AID in the EF-ACRules - GPD spec.
      0xA0,
      // External data objects - PKCS#15
      0xA1,
      // Indirect value.
      0xA5,
      // EF_ODF data objects.
      0xA7
    ];
    let result = {};

    if (typeof bytes === "string") {
      bytes = SEUtils.hexStringToByteArray(bytes);
    }

    if (!Array.isArray(bytes)) {
      debug("Passed value is not an array nor a string.");
      return null;
    }

    for (let pos = 0; pos < bytes.length; ) {
      let tag = bytes[pos],
          length = bytes[pos + 1],
          value = bytes.slice(pos + 2, pos + 2 + length),
          parsed = null;

      // Support for 0xFF padded files (GPD 7.1.2)
      if (tag === 0xFF) {
        break;
      }

      if (containerTags.indexOf(tag) >= 0) {
        parsed = _parseTLV(value);
      } else {
        parsed = value;
      }

      if (!result[tag]) {
        result[tag] = parsed;
      } else if (Array.isArray(result[tag])) {
        result[tag].push(parsed);
      } else {
        result[tag] = [result[tag], parsed];
      }

      pos = pos + 2 + length;
    }

    return result;
  },

  _ensureIsArray: function _ensureIsArray(obj) {
    return Array.isArray(obj) ? obj : [obj];
  },

  // TODO consider removing if better format for storing
  // APDU consts will be introduced
  _bytesToAPDU: function _bytesToAPDU(arr) {
    let apdu = {
      cla: arr[0] & 0xFF,
      ins: arr[1] & 0xFF,
      p1: arr[2] & 0xFF,
      p2: arr[3] & 0xFF,
      p3: arr[4] & 0xFF,
      le: 0
    };

    let data = (apdu.p3 > 0) ? (arr.slice(5)) : [];
    apdu.data = (data.length) ? SEUtils.byteArrayToHexString(data) : null;
    return apdu;
  },

  classID: Components.ID("{3e046b4b-9e66-439a-97e0-98a69f39f55f}"),
  contractID: "@mozilla.org/secureelement/access-control/rules-manager/gp;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIAccessRulesManager])
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([GPAccessRulesManager]);
