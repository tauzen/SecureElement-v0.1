/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2014, Deutsche Telekom, Inc. */

"use strict";

this.SEUtils = {
  byteArrayToHexString: function byteArrayToHexString(array) {
    let hexStr = "";

    let len = Array.isArray(array) ? array.length : 0;
    for (let i = 0; i < len; i++) {
      let hex = (array[i] & 0xff).toString(16);
      hex = (hex.length === 1) ? "0" + hex : hex;
      hexStr += hex;
    }

    return hexStr.toUpperCase();
  },

  hexStringToByteArray: function hexStringToByteArray(hexStr) {
    if (typeof hexStr !== "string" || hexStr.length % 2 !== 0) {
      return [];
    }

    let array = [];
    for (let i = 0, len = hexStr.length; i < len; i += 2) {
      array.push(parseInt(hexStr.substr(i, 2), 16));
    }

    return array;
  },

  arraysEqual: function arraysEqual(a1, a2) {
    if (!Array.isArray(a1) || !Array.isArray(a2)) {
      return false;
    }

    if (a1.length !== a2.length) {
      return false;
    }

    for (let i = 0, len = a1.length; i < len; i++) {
      if (a1[i] !== a2[i]) {
        return false;
      }
    }

    return true;
  },

  /**
   * Simple Tag-length-value utility used to parse ARF structure
   * according to GPD Secure Element Access Control section 7
   * @todo investigate if full TLV parser needed
   */
  simpleTLV: {
    // PKCS#15 container tags
    CONTAINER_TAGS: [0x30, 0x62, 0xA0, 0xA1, 0xA5, 0xA7],

    /**
     * Returns an object representing TLV structure
     * @param tlv - byte array or hex string tlv
     * @return object represenation of TLV structure
     */
    parse: function parse(tlv) {
      if (typeof tlv === "string") {
        tlv = SEUtils.hexStringToBytes(tlv);
      }

      if (!Array.isArray(tlv)) {
        return null;
      }

      let result = {};
      for (let pos = 0, len = tlv.length; pos < len;) {
        let tag = tlv[pos];
        let length = tlv[pos + 1];
        let value = tlv.slice(pos + 2, pos + 2 + length);
        let parsed = null;

        // Support for 0xFF padded files (GPD 7.1.2)
        if (tag === 0xFF) {
          break;
        }

        if (this.CONTAINER_TAGS.indexOf(tag) >= 0) {
          parsed = parse(value);
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

    // simplifies working with parsed TLVs, since
    // value does not have to be an Array
    ensureIsArray: function ensureIsArray(obj) {
      return Array.isArray(obj) ? obj : [obj];
    },
  }
};

this.EXPORTED_SYMBOLS = ["SEUtils"];