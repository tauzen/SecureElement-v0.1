"use strict";

/* globals mocha, chai, describe, it, beforeEach, SEUtils, GPAccessRulesManager,
   ACEService */

mocha.setup("bdd");
let expect = chai.expect;

// Helpers to make assertions a bit more readable.
let HASH_APP1 = [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
                 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
                 0x11, 0x11],
    HASH_APP2 = [0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22,
                 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22,
                 0x22, 0x22],
    HASH_APP3 = [0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33,
                 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33,
                 0x33, 0x33],
    HASH_APP4 = [0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44,
                 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44,
                 0x44, 0x44],
    AID_1     = [0xA0, 0x00, 0x00, 0x01, 0x51, 0x01],
    AID_2     = [0xA0, 0x00, 0x00, 0x01, 0x51, 0x02],
    AID_3     = [0xA0, 0x00, 0x00, 0x01, 0x51, 0x03],
    AID_4     = [0xA0, 0x00, 0x00, 0x01, 0x51, 0x04],
    AID_5     = [0xA0, 0x00, 0x00, 0x01, 0x51, 0x05];

let simScenario1 = {
  name: "SIM 1",
  expectedRules: [
    {
      "applet": "all",
      "application": [[166, 131, 164, 69, 7, 214, 124, 90, 88, 210, 59,
                       207, 45, 203, 171, 237, 154, 236, 33, 40]]
    }
  ],
  decisionAsserts: [
    {
      name: "Access denied for unknown application.",
      applet: [0, 1, 2, 3],
      application: [0x01, 0x02, 0x03, 0x04, 0x05],
      expectedDecision: false
    },
    {
      name: "Access allowed for a known app to AID 1.",
      applet: [0, 1, 2, 3],
      application: [166, 131, 164, 69, 7, 214, 124, 90, 88, 210, 59,
                    207, 45, 203, 171, 237, 154, 236, 33, 40],
      expectedDecision: true
    },
    {
      name: "Access allowed for a known app to AID 2.",
      applet: [4, 5, 6, 7],
      application: [166, 131, 164, 69, 7, 214, 124, 90, 88, 210, 59,
                    207, 45, 203, 171, 237, 154, 236, 33, 40],
      expectedDecision: true
    }
  ],
  steps: [
    // AID should be passed in the open channel instead.
    /*{
      "desc": "Select PKCS#15",
      "request": "00 A4 00 04 02 7F 50",
      "response": "62 27" +
                     "82 02 78 21" +
                     "83 02 7F 50" +
                     "A5 06" +
                        "83 04 00 04 C1 EC" +
                     "8A 01 05" +
                     "8B 06 2F 06 01 16 00 14" +
                     "C6 06" +
                        "90 01 00" +
                        "83 01 01" +
                     "81 02 FF FF"
    },*/
    {
      "desc": "Select ODF",
      "request": "00 A4 00 04 02 50 31",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 50 31" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 10" +
                     "81 02 00 22" +
                     "88 00"
    },
    {
      "desc": "Read ODF",
      "request": "00 B0 00 00 00", //10",
      "response": "A7 06" +
                     "30 04" +
                         "04 02 44 01"
    },
    {
      "desc": "Select DODF",
      "request": "00 A4 00 04 02 44 01",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 44 01" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 A4" +
                     "81 02 00 B6" +
                     "88 00"
    },
    {
      "desc": "Read DODF",
      "request": "00 B0 00 00 00", //A4",
      "response": "A1 29" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C" +
                     //      ; G  P     S  E     A  c  c     C  t  l
                     "A1 14" +
                        "30 12" +
                           "06 0A 2A 86 48 86 FC 6B 81 48 01 01" +
                           "30 04" +
                              "04 02 43 00" +          // ACMain file ID (4300)
                  "A1 2B" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 53 41 54 53 41 20 47 54 4F 20 31 2E 31" +
                     //      ; S  A  T  S  A     G  T  O     1  .  1
                     "A1 16" +
                        "30 14" +
                           "06 0C 2B 06 01 04 01 2A 02 6E 03 01 01 01" +
                           "30 04" +
                              "04 02 45 31"            // ACMain file ID (4531)
    },
    {
      "desc": "Select ACMF",
      "request": "00 A4 00 04 02 43 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 14" +
                     "81 02 00 26" +
                     "88 00"
    },
    {
      "desc": "Read ACMF",
      "request": "00 B0 00 00 00", //14",
      "response": "30 10" +
                     "04 08 01 02 03 04 05 06 07 08" +    // Refresh tag
                     "30 04" +
                        "04 02 43 01"
    },
    {
      "desc": "Select ACRules",
      "request": "00 A4 00 04 02 43 01",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 01" +
                     "A5 03 C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 07 D0" +
                     "81 02 07 E2" +
                     "88 00"
    },
    {
      "desc": "Read ACRules (TODO: confirm command syntax)",
      "request": "00 B0 00 00 00", //07 D0",
      "response": "30 08" +
                     "82 00" +
                     "30 04" +
                        "04 02 43 11"
    },
    {
      "desc": "Select ACCondition",
      "request": "00 A4 00 04 02 43 11",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 11" +
                     "A5 03 C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 32" +
                     "81 02 00 44" +
                     "88 00 "
    },
    {
      "desc": "Read ACCondition",
      "request": "00 B0 00 00 00", //32",
      "response": "30 16" +
                     "04 14" +
                         "A6 83 A4 45 07 D6 7C 5A 58 D2 3B CF 2D CB AB ED 9A" +
                         " EC 21 28"
    }
  ]
};

let gpdScenario1 = {
  name: "GPD example 1",
  expectedRules: [
    {
      applet: AID_1,
      application: "denied-all"
    },
    {
      applet: AID_2,
      application: [HASH_APP1]
    },
    {
      applet: AID_3,
      application: [HASH_APP1]
    },
    {
      applet: "all",
      application: "allowed-all"
    }
  ],
  decisionAsserts: [
    {
      name: "Access denied for app 1 to applet 1.",
      applet: AID_1,
      application: HASH_APP1,
      expectedDecision: false
    },
    {
      name: "Access allowed for app 1 to applet 2.",
      applet: AID_2,
      application: HASH_APP1,
      expectedDecision: true
    },
    {
      name: "Access allowed for app 1 to applet 3.",
      applet: AID_3,
      application: HASH_APP1,
      expectedDecision: true
    },
    {
      name: "Access denied for app 2 to applet 1.",
      applet: AID_1,
      application: HASH_APP2,
      expectedDecision: false
    },
    {
      name: "Access denied for app 2 to applet 2.",
      applet: AID_2,
      application: HASH_APP2,
      expectedDecision: false
    },
    {
      name: "Access denied for app 2 to applet 3.",
      applet: AID_3,
      application: HASH_APP2,
      expectedDecision: false
    },
    {
      name: "Access allowed for app 1 to other applet.",
      applet: [0xA0, 0x00, 0x00, 0x01, 0x51, 0xFF],
      application: HASH_APP1,
      expectedDecision: true
    },
    {
      name: "Access allowed for app 2 to other applet.",
      applet: [0xA0, 0x00, 0x00, 0x01, 0x51, 0xFF],
      application: HASH_APP2,
      expectedDecision: true
    }
  ],
  steps: [
    {
      "desc": "Select ODF",
      "request": "00 A4 00 04 02 50 31",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 50 31" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 10" +
                     "81 02 00 22" +
                     "88 00"
    },
    {
      "desc": "Read ODF",
      "request": "00 B0 00 00 00", // 10",
      "response": "A7 06" +
                     "30 04" +
                         "04 02 52 07"
    },
    {
      "desc": "Select DODF",
      "request": "00 A4 00 04 02 52 07",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 44 01" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 A4" +
                     "81 02 00 2B" +
                     "88 00"
    },
    {
      "desc": "Read DODF",
      "request": "00 B0 00 00 00", //A4",
      "response": "A1 29" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C" +
                     //      ; G  P     S  E     A  c  c     C  t  l
                     "A1 14" +
                        "30 12" +
                           "06 0A 2A 86 48 86 FC 6B 81 48 01 01" +
                           "30 04" +
                              "04 02 42 00"            // ACMain file ID (4200)
    },
    {
      "desc": "Select ACMF",
      "request": "00 A4 00 04 02 42 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 14" +
                     "81 02 00 26" +
                     "88 00"
    },
    {
      "desc": "Read ACMF",
      "request": "00 B0 00 00 00", //14",
      "response": "30 10" +
                     "04 08 01 02 03 04 05 06 07 08" +    // Refresh tag
                     "30 04" +
                        "04 02 43 00"
    },
    {
      "desc": "Select ACRules",
      "request": "00 A4 00 04 02 43 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 14" +
                     "81 02 00 40" +
                     "88 00"
    },
    {
      "desc": "Read ACRules",
      "request": "00 B0 00 00 00", //14",
      "response": "30 10   A0 08 04 06 A0 00 00 01 51 01   30 04 04 02 43 10" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 02   30 04 04 02 43 11" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 03   30 04 04 02 43 11" +
                  "30 08   82 00                           30 04 04 02 43 12"
    },
    {
      "desc": "Select ACCondition 1",
      "request": "00 A4 00 04 02 43 10",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 00" +
                     "81 02 00 00" +
                     "88 00"
    },
    {
      "desc": "Select ACCondition 2",
      "request": "00 A4 00 04 02 43 11",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 18" +
                     "81 02 00 18" +
                     "88 00"
    },
    {
      "desc": "Read ACCondition 2",
      "request": "00 B0 00 00 00", //18",
      "response": "30 16" +
                     "04 14 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11" +
                     " 11 11 11 11"
    },
    {
      "desc": "Select ACCondition 3",
      "request": "00 A4 00 04 02 43 12",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 02" +
                     "81 02 00 02" +
                     "88 00"
    },
    {
      "desc": "Read ACCondition 3",
      "request": "00 B0 00 00 00", //02",
      "response": "30 00"
    }
  ]
};

let gpdScenario2 = {
  name: "GPD example 2",
  expectedRules: [
    {
      applet: AID_1,
      application: "allowed-all"
    },
    {
      applet: AID_2,
      application: [HASH_APP1]
    },
    {
      applet: AID_3,
      application: [HASH_APP1, HASH_APP2, HASH_APP3]
    },
    {
      applet: AID_4,
      application: "denied-all"
    },
    {
      applet: AID_5,
      application: "denied-all"
    },
    {
      applet: "all",
      application: "denied-all"
    }
  ],
  decisionAsserts: [
    {
      name: "Access allowed for app 1 to applet 1.",
      applet: AID_1,
      application: HASH_APP1,
      expectedDecision: true
    },
    {
      name: "Access allowed for app 2 to applet 1.",
      applet: AID_1,
      application: HASH_APP2,
      expectedDecision: true
    },
    {
      name: "Access allowed for app 3 to applet 1.",
      applet: AID_1,
      application: HASH_APP3,
      expectedDecision: true
    },
    {
      name: "Access allowed for app 4 to applet 1.",
      applet: AID_1,
      application: HASH_APP4,
      expectedDecision: true
    },
    {
      name: "Access allowed for app 1 to applet 2.",
      applet: AID_2,
      application: HASH_APP1,
      expectedDecision: true
    },
    {
      name: "Access denied for app 2 to applet 2.",
      applet: AID_2,
      application: HASH_APP2,
      expectedDecision: false
    },
    {
      name: "Access denied for app 3 to applet 2.",
      applet: AID_2,
      application: HASH_APP3,
      expectedDecision: false
    },
    {
      name: "Access denied for app 4 to applet 2.",
      applet:AID_2,
      application: HASH_APP4,
      expectedDecision: false
    },
    {
      name: "Access allowed for app 1 to applet 3.",
      applet: AID_3,
      application: HASH_APP1,
      expectedDecision: true
    },
    {
      name: "Access allowed for app 2 to applet 3.",
      applet: AID_3,
      application: HASH_APP2,
      expectedDecision: true
    },
    {
      name: "Access allowed for app 3 to applet 3.",
      applet: AID_3,
      application: HASH_APP3,
      expectedDecision: true
    },
    {
      name: "Access denied for app 4 to applet 3.",
      applet: AID_3,
      application: HASH_APP4,
      expectedDecision: false
    },
    {
      name: "Access denied for app 1 to applet 4.",
      applet: AID_4,
      application: HASH_APP1,
      expectedDecision: false
    },
    {
      name: "Access denied for app 2 to applet 4.",
      applet: AID_4,
      application: HASH_APP2,
      expectedDecision: false
    },
    {
      name: "Access denied for app 3 to applet 4.",
      applet: AID_4,
      application: HASH_APP3,
      expectedDecision: false
    },
    {
      name: "Access denied for app 4 to applet 4.",
      applet: AID_4,
      application: HASH_APP4,
      expectedDecision: false
    },
    {
      name: "Access denied for app 1 to applet 5.",
      applet: AID_5,
      application: HASH_APP1,
      expectedDecision: false
    },
    {
      name: "Access denied for app 2 to applet 5.",
      applet: AID_5,
      application: HASH_APP2,
      expectedDecision: false
    },
    {
      name: "Access denied for app 3 to applet 5.",
      applet: AID_5,
      application: HASH_APP3,
      expectedDecision: false
    },
    {
      name: "Access denied for app 4 to applet 5.",
      applet: AID_5,
      application: HASH_APP4,
      expectedDecision: false
    },
    {
      name: "Access denied for app 1 to other applets.",
      applet: [0xA0, 0x00, 0x00, 0x01, 0x51, 0xFF],
      application: HASH_APP1,
      expectedDecision: false
    },
    {
      name: "Access denied for app 2 to other applets.",
      applet: [0xA0, 0x00, 0x00, 0x01, 0x51, 0xFF],
      application: HASH_APP2,
      expectedDecision: false
    },
    {
      name: "Access denied for app 3 to other applets.",
      applet: [0xA0, 0x00, 0x00, 0x01, 0x51, 0xFF],
      application: HASH_APP3,
      expectedDecision: false
    },
    {
      name: "Access denied for app 4 to other applets.",
      applet: [0xA0, 0x00, 0x00, 0x01, 0x51, 0xFF],
      application: HASH_APP4,
      expectedDecision: false
    },
  ],
  steps: [
    {
      "desc": "Select ODF",
      "request": "00 A4 00 04 02 50 31",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 50 31" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 10" +
                     "81 02 00 22" +
                     "88 00"
    },
    {
      "desc": "Read ODF",
      "request": "00 B0 00 00 00", //10",
      "response": "A7 06" +
                     "30 04" +
                         "04 02 52 07"
    },
    {
      "desc": "Select DODF",
      "request": "00 A4 00 04 02 52 07",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 44 01" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 A4" +
                     "81 02 00 2B" +
                     "88 00"
    },
    {
      "desc": "Read DODF",
      "request": "00 B0 00 00 00", //A4",
      "response": "A1 29" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C" +
                     //      ; G  P     S  E     A  c  c     C  t  l
                     "A1 14" +
                        "30 12" +
                           "06 0A 2A 86 48 86 FC 6B 81 48 01 01" +
                           "30 04" +
                              "04 02 42 00"            // ACMain file ID (4200)
    },
    {
      "desc": "Select ACMF",
      "request": "00 A4 00 04 02 42 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 14" +
                     "81 02 00 26" +
                     "88 00"
    },
    {
      "desc": "Read ACMF",
      "request": "00 B0 00 00 00", //14",
      "response": "30 10" +
                     "04 08 01 02 03 04 05 06 07 08" +    // Refresh tag
                     "30 04" +
                        "04 02 43 00"
    },
    {
      "desc": "Select ACRules",
      "request": "00 A4 00 04 02 43 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 14" +
                     "81 02 00 40" +
                     "88 00"
    },
    {
      "desc": "Read ACRules",
      "request": "00 B0 00 00 00", //14",
      "response": "30 10   A0 08 04 06 A0 00 00 01 51 01   30 04 04 02 43 10" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 02   30 04 04 02 43 11" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 03   30 04 04 02 43 12" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 04   30 04 04 02 43 13" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 05   30 04 04 02 43 13" +
                  "30 08   82 00                           30 04 04 02 43 13"
    },
    {
      "desc": "Select ACCondition 1",
      "request": "00 A4 00 04 02 43 10",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 02" +
                     "81 02 00 00" +
                     "88 00"
    },
    {
      "desc": "Read ACCondition 1",
      "request": "00 B0 00 00 00", //02",
      "response": "30 00"
    },
    {
      "desc": "Select ACCondition 2",
      "request": "00 A4 00 04 02 43 11",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 18" +
                     "81 02 00 18" +
                     "88 00"
    },
    {
      "desc": "Read ACCondition 2",
      "request": "00 B0 00 00 00", //18",
      "response": "30 16" +
                     "04 14 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 " +
                     "11 11 11 11"
    },
    {
      "desc": "Select ACCondition 3",
      "request": "00 A4 00 04 02 43 12",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 48" +
                     "81 02 00 48" +
                     "88 00"
    },
    {
      "desc": "Read ACCondition 3",
      "request": "00 B0 00 00 00", //48",
      "response": "30 16" +
                     "04 14 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 " +
                     " 11 11 11 11" +
                  "30 16" +
                     "04 14 22 22 22 22 22 22 22 22 22 22 22 22 22 22 22 22 " +
                     " 22 22 22 22" +
                  "30 16" +
                     "04 14 33 33 33 33 33 33 33 33 33 33 33 33 33 33 33 33 " +
                     " 33 33 33 33"
    },
    {
      "desc": "Select ACCondition 4",
      "request": "00 A4 00 04 02 43 13",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 00" +
                     "81 02 00 00" +
                     "88 00"
    }
  ]
};

let gpdScenario3 = {
  name: "GPD example 3",
  // This scenario is not supported yet, so it should contain empty rule set.
  expectedRules: [],
  decisionAsserts: [],
  steps: [
    {
      "desc": "Select ODF",
      "request": "00 A4 00 04 02 50 31",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 50 31" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 10" +
                     "81 02 00 22" +
                     "88 00"
    },
    {
      "desc": "Read ODF",
      "request": "00 B0 00 00 00", //10",
      "response": "A7 06" +
                     "30 04" +
                         "04 02 52 07"
    },
    {
      "desc": "Select DODF",
      "request": "00 A4 00 04 02 52 07",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 44 01" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 A4" +
                     "81 02 00 2B" +
                     "88 00"
    },
    {
      "desc": "Read DODF",
      "request": "00 B0 00 00 00", //A4",
      "response": "A1 29" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C" +
                     //      ; G  P     S  E     A  c  c     C  t  l
                     "A1 14" +
                        "30 12" +
                           "06 0A 2A 86 48 86 FC 6B 81 48 01 01" +
                           "30 04" +
                              "04 02 42 00"            // ACMain file ID (4200)
    },
    {
      "desc": "Select ACMF",
      "request": "00 A4 00 04 02 42 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 14" +
                     "81 02 00 26" +
                     "88 00"
    },
    {
      "desc": "Read ACMF",
      "request": "00 B0 00 00 00", //14",
      "response": "30 10" +
                     "04 08 01 02 03 04 05 06 07 08" +    // Refresh tag
                     "30 04" +
                        "04 02 43 00"
    },
    {
      "desc": "Select ACRules",
      "request": "00 A4 00 04 02 43 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 40" +
                     "81 02 00 40" +
                     "88 00"
    },
    {
      "desc": "Read ACRules",
      "request": "00 B0 00 00 00", //40",
      "response": "30 08   81 00                           30 04 04 02 43 80" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 01   30 04 04 02 43 81" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 02   30 04 04 02 43 82" +
                  "30 10   A0 08 04 06 A0 00 00 01 51 03   30 04 04 02 43 83"
    },
    {
      "desc": "Select ACCondition 1",
      "request": "00 A4 00 04 02 43 80",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 1B" +
                     "81 02 00 1B" +
                     "88 00"
    },
    {
      "desc": "Read ACCondition 1",
      "request": "00 B0 00 00 00", //1B",
      "response": "30 16" +
                     "04 14 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 " +
                     " 00 00 00 00"
    },
    {
      "desc": "Select ACCondition 2",
      "request": "00 A4 00 04 02 43 81",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 18" +
                     "81 02 00 18" +
                     "88 00"
    },
    {
      "desc": "Read ACCondition 2",
      "request": "00 B0 00 00 00", //18",
      "response": "30 16" +
                     "04 14 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 " +
                     " 11 11 11 11"
    },
    {
      "desc": "Select ACCondition 3",
      "request": "00 A4 00 04 02 43 82",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 37" +
                     "81 02 00 37" +
                     "88 00"
    },
    {
      "desc": "Read ACCondition 3",
      "request": "00 B0 00 00 00", //37",
      "response": "30 35" +
                     "04 14 22 22 22 22 22 22 22 22 22 22 22 22 22 22 22 22 " +
                     " 22 22 22 22" +
                     "A0 1D" +
                        "A0 16" +
                           "A1 14" +
                               "04 08 80 F2 00 00 FF FF FF FF" +
                               "04 08 80 CA 00 00 FF FF 00 00" +
                    "A1 03" +
                       "80 01 00"
    },
    {
      "desc": "Select ACCondition 4",
      "request": "00 A4 00 04 02 43 83",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 02" +
                     "81 02 00 02" +
                     "88 00",
    },
    {
      "desc": "Read ACCondition 4",
      "request": "00 B0 00 00 00", //02",
      "response": "30 00"
    }
  ]
};

let multipleAcmfFilesScenario = {
  name: "Multiple ACMF files.",
  expectedRules: [],
  decisionAsserts: [
    {
      name: "Access denied for app 1 to applet 1.",
      applet: AID_1,
      application: HASH_APP1,
      expectedDecision: false
    },
    {
      name: "Access denied for app 1 to applet 2.",
      applet: AID_2,
      application: HASH_APP1,
      expectedDecision: false
    }
  ],
  steps: [
    {
      "desc": "Select ODF",
      "request": "00 A4 00 04 02 50 31",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 50 31" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 10" +
                     "81 02 00 22" +
                     "88 00"
    },
    {
      "desc": "Read ODF",
      "request": "00 B0 00 00 00", //10",
      "response": "A7 06" +
                     "30 04" +
                         "04 02 52 07"
    },
    {
      "desc": "Select DODF",
      "request": "00 A4 00 04 02 52 07",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 44 01" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 A4" +
                     "81 02 00 2B" +
                     "88 00"
    },
    {
      "desc": "Read DODF",
      "request": "00 B0 00 00 00", //A4",
      "response": "A1 29" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C" +
                     //      ; G  P     S  E     A  c  c     C  t  l
                     "A1 14" +
                        "30 12" +
                           "06 0A 2A 86 48 86 FC 6B 81 48 01 01" +
                           "30 04" +
                              "04 02 42 00" +          // ACMain file ID (4200)
                  "A1 29" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C" +
                     //      ; G  P     S  E     A  c  c     C  t  l
                     "A1 14" +
                        "30 12" +
                           "06 0A 2A 86 48 86 FC 6B 81 48 01 01" +
                           "30 04" +
                              "04 02 42 00"            // ACMain file ID (4200)
    }
  ]
};

// Based on sim card 1 scenario.
let refreshTag = {
  name: "Refresh tag.",
  expectedRules: [
    {
      "applet": "all",
      "application": [[166, 131, 164, 69, 7, 214, 124, 90, 88, 210, 59,
                       207, 45, 203, 171, 237, 154, 236, 33, 40]]
    }
  ],
  decisionAsserts: [
    {
      name: "Access denied for unknown application.",
      applet: [0, 1, 2, 3],
      application: [0x01, 0x02, 0x03, 0x04, 0x05],
      expectedDecision: false
    },
    {
      name: "Access allowed for a known app to AID 1.",
      applet: [0, 1, 2, 3],
      application: [166, 131, 164, 69, 7, 214, 124, 90, 88, 210, 59,
                    207, 45, 203, 171, 237, 154, 236, 33, 40],
      expectedDecision: true
    },
    {
      name: "Access allowed for a known app to AID 2.",
      applet: [4, 5, 6, 7],
      application: [166, 131, 164, 69, 7, 214, 124, 90, 88, 210, 59,
                    207, 45, 203, 171, 237, 154, 236, 33, 40],
      expectedDecision: true
    }
  ],
  steps: [
    {
      "desc": "Select ODF",
      "request": "00 A4 00 04 02 50 31",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 50 31" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 10" +
                     "81 02 00 22" +
                     "88 00"
    },
    {
      "desc": "Read ODF",
      "request": "00 B0 00 00 00", //10",
      "response": "A7 06" +
                     "30 04" +
                         "04 02 44 01"
    },
    {
      "desc": "Select DODF",
      "request": "00 A4 00 04 02 44 01",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 44 01" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 A4" +
                     "81 02 00 B6" +
                     "88 00"
    },
    {
      "desc": "Read DODF",
      "request": "00 B0 00 00 00", //A4",
      "response": "A1 29" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C" +
                     //      ; G  P     S  E     A  c  c     C  t  l
                     "A1 14" +
                        "30 12" +
                           "06 0A 2A 86 48 86 FC 6B 81 48 01 01" +
                           "30 04" +
                              "04 02 43 00" +          // ACMain file ID (4300)
                  "A1 2B" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 53 41 54 53 41 20 47 54 4F 20 31 2E 31" +
                     //      ; S  A  T  S  A     G  T  O     1  .  1
                     "A1 16" +
                        "30 14" +
                           "06 0C 2B 06 01 04 01 2A 02 6E 03 01 01 01" +
                           "30 04" +
                              "04 02 45 31"            // ACMain file ID (4531)
    },
    {
      "desc": "Select ACMF",
      "request": "00 A4 00 04 02 43 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 14" +
                     "81 02 00 26" +
                     "88 00"
    },
    {
      "desc": "Read ACMF",
      "request": "00 B0 00 00 00", //14",
      "response": "30 10" +
                     "04 08 01 02 03 04 05 06 07 08" +    // Refresh tag
                     "30 04" +
                        "04 02 43 01"
    },
    {
      "desc": "Select ACRules",
      "request": "00 A4 00 04 02 43 01",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 01" +
                     "A5 03 C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 07 D0" +
                     "81 02 07 E2" +
                     "88 00"
    },
    {
      "desc": "Read ACRules (TODO: confirm command syntax)",
      "request": "00 B0 00 00 00", //07 D0",
      "response": "30 08" +
                     "82 00" +
                     "30 04" +
                        "04 02 43 11"
    },
    {
      "desc": "Select ACCondition",
      "request": "00 A4 00 04 02 43 11",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 11" +
                     "A5 03 C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 32" +
                     "81 02 00 44" +
                     "88 00 "
    },
    {
      "desc": "Read ACCondition",
      "request": "00 B0 00 00 00", //32",
      "response": "30 16" +
                     "04 14" +
                         "A6 83 A4 45 07 D6 7C 5A 58 D2 3B CF 2D CB AB ED 9A" +
                         " EC 21 28"
    }
  ],
  withRefreshTagSteps: [
    {
      "desc": "Select ODF",
      "request": "00 A4 00 04 02 50 31",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 50 31" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 10" +
                     "81 02 00 22" +
                     "88 00"
    },
    {
      "desc": "Read ODF",
      "request": "00 B0 00 00 00", //10",
      "response": "A7 06" +
                     "30 04" +
                         "04 02 44 01"
    },
    {
      "desc": "Select DODF",
      "request": "00 A4 00 04 02 44 01",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 44 01" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 01" +
                     "80 02 00 A4" +
                     "81 02 00 B6" +
                     "88 00"
    },
    {
      "desc": "Read DODF",
      "request": "00 B0 00 00 00", //A4",
      "response": "A1 29" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 47 50 20 53 45 20 41 63 63 20 43 74 6C" +
                     //      ; G  P     S  E     A  c  c     C  t  l
                     "A1 14" +
                        "30 12" +
                           "06 0A 2A 86 48 86 FC 6B 81 48 01 01" +
                           "30 04" +
                              "04 02 43 00" +          // ACMain file ID (4300)
                  "A1 2B" +
                     "30 00" +
                     "30 0F" +
                        "0C 0D 53 41 54 53 41 20 47 54 4F 20 31 2E 31" +
                     //      ; S  A  T  S  A     G  T  O     1  .  1
                     "A1 16" +
                        "30 14" +
                           "06 0C 2B 06 01 04 01 2A 02 6E 03 01 01 01" +
                           "30 04" +
                              "04 02 45 31"            // ACMain file ID (4531)
    },
    {
      "desc": "Select ACMF",
      "request": "00 A4 00 04 02 43 00",
      "response": "62 22" +
                     "82 02 41 21" +
                     "83 02 43 00" +
                     "A5 03" +
                        "C0 01 40" +
                     "8A 01 05" +
                     "8B 06 6F 06 01 01 00 00" +
                     "80 02 00 14" +
                     "81 02 00 26" +
                     "88 00"
    },
    {
      "desc": "Read ACMF",
      "request": "00 B0 00 00 00", //14",
      "response": "30 10" +
                     "04 08 01 02 03 04 05 06 07 08" +    // Refresh tag
                     "30 04" +
                        "04 02 43 01"
    }
  ]
};


describe("GPAccessRulesManager methods.", function() {
  describe("_parseTLV.", function() {
    let assertHelper = function(bytesStr, expected) {
      let bytes = SEUtils.hexStringToByteArray(bytesStr.replace(/\s+/g, ""));
      let rulesManager = new GPAccessRulesManager();
      let parsed = rulesManager._parseTLV(bytes);
      expect(parsed).to.eql(expected);
    };

    it("Parses real select response.", function() {
      let bytes = "62 27 82 02 78 21 83 02 7F 50 A5 06 83 04 00 04 C1 DC 8A" +
                  "01 05 8B 06 2F 06 01 16 00 14 C6 06 90 01 00 83 01 01 81" +
                  "02 FF FF";

      let expected = {
        0x62: {
          0x82: [0x78, 0x21],
          0x83: [0x7F, 0x50],
          0xA5: {
            0x83: [0x00, 0x04, 0xC1, 0xDC]
          },
          0x8A: [0x05],
          0x8B: [0x2F, 0x06, 0x01, 0x16, 0x00, 0x14],
          0xC6: [0x90, 0x01, 0x00, 0x83, 0x01, 0x01],
          0x81: [0xFF, 0xFF]
        }
      };

      assertHelper(bytes, expected);
    });

    it("Parses real DODF file, with 0xFF padding.", function() {
      let bytes = "A1 29 30 00 30 0F 0C 0D 47 50 20 53 45 20 41 63 63 20 43" +
                  "74 6C A1 14 30 12 06 0A 2A 86 48 86 FC 6B 81 48 01 01 30" +
                  "04 04 02 43 00 A1 2B 30 00 30 0F 0C 0D 53 41 54 53 41 20" +
                  "47 54 4F 20 31 2E 31 A1 16 30 14 06 0C 2B 06 01 04 01 2A" +
                  "02 6E 03 01 01 01 30 04 04 02 45 31 FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF";

      let expected = {
        0xA1: [
          {
            0x30: [
              {},
              {
                0x0C: [0x47, 0x50, 0x20, 0x53, 0x45, 0x20, 0x41, 0x63, 0x63,
                       0x20, 0x43, 0x74, 0x6C]
              }
            ],
            0xA1: {
              0x30: {
                0x06: [0x2A, 0x86, 0x48, 0x86, 0xFC, 0x6B, 0x81, 0x48, 0x01,
                       0x01],
                0x30: {
                  0x04: [0x43, 0x00]
                }
              }
            }
          },
          {
            0x30: [
              {},
              {
                0x0C: [0x53, 0x41, 0x54, 0x53, 0x41, 0x20, 0x47, 0x54, 0x4F,
                       0x20, 0x31, 0x2E, 0x31]
              }
            ],
            0xA1: {
              0x30: {
                0x06: [0x2B, 0x06, 0x01, 0x04, 0x01, 0x2A, 0x02, 0x6E, 0x03,
                       0x01, 0x01, 0x01],
                0x30: {
                  0x04: [0x45, 0x31]
                }
              }
            }
          }
        ]
      };

      assertHelper(bytes, expected);
    });

    it("Parses real ACRules file, with 0xFF padding.", function() {
      let bytes = "30 08 82 00 30 04 04 02 43 11 FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF" +
                  "FF FF FF FF FF FF FF FF FF";

      let expected = {
        0x30: {
          0x82: [],
          0x30: {
            0x04: [0x43, 0x11]
          }
        }
      };

      assertHelper(bytes, expected);
    });
  });
});

let scenarios = [
  simScenario1,
  gpdScenario1,
  gpdScenario2,
  gpdScenario3,
  multipleAcmfFilesScenario
];

let mockApp = (manifestURL, certHashArray) => {
  window.DOMApplicationRegistry = {
    getAppByManifestURL: (_manifestURL) => {
      if (manifestURL !== _manifestURL) {
        return null;
      }

      return {
        dev_cert_hash: SEUtils.byteArrayToHexString(certHashArray)
      };
    }
  };
};

scenarios.forEach((scenario) => {
  describe("Scenario: " + scenario.name, () => {

    beforeEach((done) => {
      window.ACE_TEST_SCENARIO = scenario;
      ACEService.init(done);
    });

    it("Rules should be read to an internal representation.", (done) => {
      mockApp("no hash", [1, 2, 3]);

      ACEService.isAccessAllowed("no hash", [])
      .then(() => {
        let actual = ACEService._ruleManager.rules;

        let expected = scenario.expectedRules;
        expect(actual).to.be.defined;
        expect(expected).to.be.defined;

        expect(actual.length, "Not the same number of rules " +
               JSON.stringify(actual, 0, 2)).to.equal(expected.length);

        actual.forEach((actualRule, pos) => {
          let expectedRule = expected[pos];

          expect(actualRule.applet, "Applet diff at pos " + pos)
            .to.eql(expectedRule.applet);

          expect(actualRule.application, "Application diff at pos " + pos)
            .to.eql(expectedRule.application);
        });

        done();
      });
    });

    describe("Decision making.", function() {
      for (let decisionExpectation of scenario.decisionAsserts) {
        it(decisionExpectation.name, (done) => {
          mockApp("manifest url", decisionExpectation.application);

          let applet = decisionExpectation.applet;

          ACEService.isAccessAllowed("manifest url", applet)
          .then((decision) => {
            expect(decision).to.equal(decisionExpectation.expectedDecision);
            done();
          });
        });
      }
    });
  });
});

// Separate, because requires to read rules multiple times.
describe('Scenario: ' + refreshTag.name, function() {
  beforeEach(() => {
    window.ACE_TEST_SCENARIO = refreshTag;
  });

  it('Reads all files at ACE init, but subsequently only up to ACMF.', function(done) {
    let decisionExpectation = refreshTag.decisionAsserts[0];
    mockApp("manifest url", decisionExpectation.application);
    let applet = decisionExpectation.applet;
    ACEService.init(() => {
      expect(MockRilContentHelper.mockPosition).to.equal(refreshTag.steps.length);
      console.log('RRRR', refreshTag.steps.length, MockRilContentHelper.mockPosition);
      refreshTag.steps = refreshTag.withRefreshTagSteps;
      ACEService.isAccessAllowed("manifest url", applet)
      .then((decision) => {
        expect(MockRilContentHelper.mockPosition).to.equal(refreshTag.steps.length);
        console.log('RRRR', refreshTag.steps.length, MockRilContentHelper.mockPosition);
        return ACEService.isAccessAllowed("manifest url", applet);
      }).then((decision) => {
        console.log('RRRR', refreshTag.steps.length, MockRilContentHelper.mockPosition);
        expect(MockRilContentHelper.mockPosition).to.equal(refreshTag.steps.length);
        done();
      });
    });
  });
});

mocha.run();
