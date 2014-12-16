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

// Set to true to debug SecureElement (SE) stack
this.DEBUG_ALL = true;

// Set individually to debug specific layers
this.DEBUG_ACE = false || DEBUG_ALL;
this.DEBUG_SE = false || DEBUG_ALL;

// Ideally this should have been 3, as we do not allow basic channel' : 0 on 'uicc'.
// Max number of supplementary logical channels available would be : [1, 2, or 3].
// Other SE types may support upto max 4.

// Maximun logical channels per session.
this.MAX_CHANNELS_ALLOWED_PER_SESSION = 4;

this.TYPE_BASIC_CHANNEL = 0;
this.TYPE_LOGICAL_CHANNEL = 1;

// According GPCardSpec 2.2
this.MAX_APDU_LEN = 255; // including APDU header
// According to ISO/IEC 7816-4, all GlobalPlatform responses returned in APDU
// response messages shall have a maximum length of 256 bytes of response data
this.MAX_APDU_RESPONSE_LEN = 256;

// CLA (1 byte) + INS (1 byte) + P1 (1 byte) + P2 (1 byte)
this.APDU_HEADER_LEN = 4;

this.CLA_BYTE_OFFSET  = 0;
this.INS_BYTE_OFFSET  = 1;
this.P1_BYTE_OFFSET   = 2;
this.P2_BYTE_OFFSET   = 3;
this.P3_BYTE_OFFSET   = 4;
this.DATA_BYTE_OFFSET = 5;

this.MIN_AID_LEN = 5;
this.MAX_AID_LEN = 16;

this.INS_SELECT = 0xA4;
this.INS_MANAGE_CHANNEL = 0x70;
this.INS_GET_RESPONSE = 0xC0;

// Match the following errors with SecureElement.webidl's SEError enum values
this.ERROR_NONE               = '';
this.ERROR_SECURITY           = 'SESecurityError';
this.ERROR_IO                 = 'SEIoError';
this.ERROR_BADSTATE           = 'SEBadStateError';
this.ERROR_INVALIDCHANNEL     = 'SEInvalidChannelError';
this.ERROR_INVALIDAPPLICATION = 'SEInvalidApplicationError';
this.ERROR_GENERIC            = 'SEGenericError';

this.TYPE_UICC = 'uicc';
this.TYPE_ESE = 'eSE';

this.gUtils = {
  hexStringToBytes: function(hexString) {
    let bytes = [];
    let length = hexString.length;

    for (let i = 0; i < length; i += 2) {
      bytes.push(Number.parseInt(hexString.substr(i, 2), 16));
    }

    return bytes;
  },

  byteTohexString: function(array) {
    let hexString = "";
    let hex;

    if (!array || array.length === 0)
      return hexString;

    for (let i = 0; i < array.length; i++) {
      hex = array[i].toString(16).toUpperCase();
      if (hex.length === 1) {
        hexString += "0";
      }
      hexString += hex;
    }
    return hexString;
  }
};

// Allow this file to be imported via Components.utils.import().
this.EXPORTED_SYMBOLS = Object.keys(this);
