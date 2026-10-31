/**
 * Constants and Configuration
 *
 * Centralized configuration for all platforms and DEXs in the AR/AO ecosystem.
 * Compatible with ao-tax-tracker-server patterns.
 *
 * @module config/constants
 */

module.exports = {
  // ============================================================
  // GraphQL Endpoints
  // ============================================================
  GQL_ENDPOINTS: {
    ARWEAVE: "https://arweave.net/graphql",
    GOLDSKY: "https://arweave-search.goldsky.com/graphql",
    AO_GOLDSKY: "https://ao-arweave.goldsky.io/graphql",
  },

  // ============================================================
  // AO Token Standard Tags
  // ============================================================
  AO_TOKEN: {
    // Standard AO token transfer tags
    TRANSFER_TAGS: {
      ACTION: "Transfer",
      RECIPIENT: "Recipient",
      QUANTITY: "Quantity",
    },
    // Credit/Debit notice tags (results of transfers)
    NOTICE_TAGS: {
      CREDIT_NOTICE: "Credit-Notice",
      DEBIT_NOTICE: "Debit-Notice",
      SENDER: "Sender",
      QUANTITY: "Quantity",
    },
    // Result tracking tag
    PUSHED_FOR: "Pushed-For",
    // Data protocol identifier
    DATA_PROTOCOL: "ao",
    TYPE: "Message",
  },

  // ============================================================
  // Known Token Registry (81 tokens from database + core tokens)
  // ============================================================
  TOKENS: {
    // ─────────────────────────────────────────────────────────────
    // Core AO Ecosystem Tokens
    // ─────────────────────────────────────────────────────────────
    "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc": {
      symbol: "AO",
      name: "AO",
      decimals: 12,
      type: "native",
    },
    xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10: {
      symbol: "wAR",
      name: "Wrapped AR",
      decimals: 12,
      type: "wrapped",
    },
    "7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ": {
      symbol: "wUSDC",
      name: "Wrapped USDC",
      decimals: 6,
      type: "wrapped",
    },
    qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE: {
      symbol: "ARIO",
      name: "AR.IO",
      decimals: 6,
      type: "native",
    },
    "4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs": {
      symbol: "PI",
      name: "Permaweb Index",
      decimals: 12,
      type: "native",
    },
    "DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo": {
      symbol: "PIXL",
      name: "PIXL",
      decimals: 6,
      type: "native",
    },
    "FBt9A5GA_KXMMSxA2DJ0xZbAq8sLLU2ak-YJe9zDvg8": {
      symbol: "USDA",
      name: "USDA Stablecoin",
      decimals: 12,
      type: "stablecoin",
    },

    // ─────────────────────────────────────────────────────────────
    // Wrapped/Bridge Tokens
    // ─────────────────────────────────────────────────────────────
    "y-p7CPhs6JMUStAuE4KeTnMXN7qYBvEi2hiBFk8ZhjM": {
      symbol: "vAR",
      name: "Vento Wrapped AR",
      decimals: 12,
      type: "bridge",
    },
    "cxkFiGP89fEKOvbvl9SLs1lEaw0L-DWJiqQOuDPeDG8": {
      symbol: "vUSDC",
      name: "Vento Wrapped USDC",
      decimals: 6,
      type: "bridge",
    },
    "NG-0lVX882MG5nhARrSzyprEK6ejonHpdUmaaMPsHE8": {
      symbol: "qAR",
      name: "Q Arweave",
      decimals: 12,
      type: "wrapped",
    },

    // ─────────────────────────────────────────────────────────────
    // Community Tokens
    // ─────────────────────────────────────────────────────────────
    "8rbAftv7RaPxFjFk5FGUVAVCSjGQB4JHDcb9P9wCVhQ": {
      symbol: "AGENT",
      name: "Agent",
      decimals: 18,
      type: "community",
    },
    "GegJSRSQptBJEF5lcr4XEqWLYFUnNr3_zKQ-P_DnDQs": {
      symbol: "AOS",
      name: "AO Strategy",
      decimals: 18,
      type: "native",
    },
    GbR9sy06IKtzjuXQ8XbUy1a17i2VtXADmvX6T22jQaw: {
      symbol: "BATMAN",
      name: "Batman",
      decimals: 12,
      type: "community",
    },
    "2nfFJb8LIA69gwuLNcFQezSuw4CXPE4--U-j-7cxKOU": {
      symbol: "AIR",
      name: "Air",
      decimals: 12,
      type: "community",
    },
    "PBg5TSJPQp9xgXGfjN27GA28Mg5bQmNEdXH2TXY4t-A": {
      symbol: "EARTH",
      name: "Earth",
      decimals: 12,
      type: "community",
    },
    aYrCboXVSl1AXL9gPFe3tfRxRf0ZmkOXH65mKT0HHZw: {
      symbol: "EXP",
      name: "Experiment",
      decimals: 12,
      type: "community",
    },
    YMs4s_KkK7JHG1y8QplgZz0RYuKL_46FLq5ZG4wWrn8: {
      symbol: "JOOSE",
      name: "Joose",
      decimals: 12,
      type: "community",
    },
    "1PIaQp_wij0H8Ykx-LuQEUqXQndryycWRjCRvV3R8lI": {
      symbol: "KARD",
      name: "Kardeshev",
      decimals: 12,
      type: "community",
    },
    BHejO1Knk0TnjvrkZQh9V8X8sh0sBGOl9B6SstQk2Ds: {
      symbol: "KARDESHEV",
      name: "Project Kardeshevs",
      decimals: 12,
      type: "community",
    },
    "pazXumQI-HPH7iFGfTC-4_7biSnqz_U67oFAGry5zUY": {
      symbol: "LLAMA",
      name: "LlamaCoin",
      decimals: 12,
      type: "community",
    },
    OT9qTE2467gcozb2g8R6D6N3nQS94ENcaAIJfUzHCww: {
      symbol: "TRUNK",
      name: "TRUNK",
      decimals: 12,
      type: "community",
    },
    wOrb8b_V8QixWyXZub48Ki5B6OIDyf_p1ngoonsaRpQ: {
      symbol: "TRUNK2",
      name: "Trunk",
      decimals: 12,
      type: "community",
    },
    GaQrvEMKBpkjofgnBi_B3IgIDmY_XYelVLB6GcRGrHc: {
      symbol: "dARIO",
      name: "Devnet ARIO",
      decimals: 12,
      type: "community",
    },
    "Sa0iBLPNyJQrwpTTG-tWLQU-1QeUAJA73DdxGGiKoJc": {
      symbol: "testnet-AOCRED",
      name: "AOCRED",
      decimals: 12,
      type: "community",
    },

    // ─────────────────────────────────────────────────────────────
    // Legacy Tokens
    // ─────────────────────────────────────────────────────────────
    "-UG-wdShrvbXMBEdiApmqR14mOuERf5Wo6rQ0fr6tWo": {
      symbol: "tqAR",
      name: "Token Legacy tqAR",
      decimals: 12,
      type: "legacy",
    },
    "mNgsrc42cWQK5cbo-89QO5OMSMUjOpFdV5PQtQMXes4": {
      symbol: "twAR",
      name: "Token Legacy twAR",
      decimals: 12,
      type: "legacy",
    },

    // ─────────────────────────────────────────────────────────────
    // Test/Development Tokens
    // ─────────────────────────────────────────────────────────────
    agYcCFJtrMG6cqMuZfskIkFTGvUPddICmtQSBIoPdiA: {
      symbol: "tARIO",
      name: "Testnet ARIO",
      decimals: 12,
      type: "test",
    },
    "elvpmNr2-2qt0gDDKjG7vuXBC533QR2VkH6huXHdEpQ": {
      symbol: "ARIO",
      name: "test-hb-patch-ario4",
      decimals: 12,
      type: "test",
    },
    "pR-D9wU04AdOFSWAsZ-7wZFXP6I9V7Ot6nkrHZdWUSY": {
      symbol: "TEST-ARIO",
      name: "Test HB Patch ARIO",
      decimals: 12,
      type: "test",
    },
    Y8pPRo3QJaZhhqzUZ0L4_A0KvuHizKYuwz44_tz3Ln4: {
      symbol: "TEST-HB",
      name: "Test HB Balances",
      decimals: 12,
      type: "test",
    },
    "xf4-AQ2pGnU54Ym6tgMnHafMKz0f_yFFi6pOZMG7jfU": {
      symbol: "TEST-TAX",
      name: "Tax Payment Test Token",
      decimals: 12,
      type: "test",
    },
    "GcFxqTQnKHcr304qnOcq00ZqbaYGDn4Wbb0DHAM-wvU": {
      symbol: "TEST-USDA",
      name: "AP Testnet USDA",
      decimals: 12,
      type: "test",
    },
    m3PaWzK4PTG9lAaqYQPaPdOcXdO8hYqi5Fe9NWqXd0w: {
      symbol: "AO-TEST",
      name: "AO Test",
      decimals: 12,
      type: "test",
    },

    // ─────────────────────────────────────────────────────────────
    // ANT (Arweave Name Tokens)
    // ─────────────────────────────────────────────────────────────
    "c4Gwrkbi-K1V6XyXWazHC-uZPaoO_8as8wZzm9207ss": {
      symbol: "ANT",
      name: "ANT-DOORMAN",
      decimals: 12,
      type: "ant",
    },
    WLSIT1FTAUp3g5YAB8ToqpVHhE7fSE7w3uFrD6MH1Zw: {
      symbol: "ANT",
      name: "ANT-ALACAZAM",
      decimals: 12,
      type: "ant",
    },
    VU3cCAqraLG6cY1nGI6pZMsdk1mH2t_rZqk6mf_XVoI: {
      symbol: "ANT",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    JpN3jJq_24iFnfKhJR0yZ0TR42BpymucBv1n6YtGohY: {
      symbol: "ANT",
      name: "ANT-I-BOUGHT-A-POTATO",
      decimals: 12,
      type: "ant",
    },
    "YcxE5IbqZYK72H64ELoysxiJ-0wb36deYPv55wgl8xo": {
      symbol: "ANT",
      name: "aos",
      decimals: 12,
      type: "ant",
    },
    "RBepCNNTipkiGRGXgebsNW1FSa-3SLuL-UBNMBms_Po": {
      symbol: "ANT",
      name: "ANT-GIGAUTILITY",
      decimals: 12,
      type: "ant",
    },
    NgfG4K9avqqP5P7m3wvk9hl1NJNuu8yn6oFVlDJs9cE: {
      symbol: "ANT",
      name: "Demo-ANT",
      decimals: 12,
      type: "ant",
    },
    "1FTU1YnPppQzvUHw3Jz3-QO4JwJUVNel_V6qOHhuxZk": {
      symbol: "ANT",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    "-IUtRutnBYxqjcHsgmBQUWeRHYV5knX8Zjgoq3EuEY0": {
      symbol: "ANT",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    "0ALZuX_sDw-Gbqd7vr6TNfl_S2zSfKqQg0axVZIH2lE": {
      symbol: "ANT",
      name: "ANT-BRAVE-BROWSER",
      decimals: 12,
      type: "ant",
    },
    xPTcAx8uS93vb8drHbQorjV5pRGbu8hqXfPBdflxBRw: {
      symbol: "ANT",
      name: "aos",
      decimals: 12,
      type: "ant",
    },
    bTPPJ_a0AaXuxTtzadlNzUMoD9vN3RwQ__25YrHnnPs: {
      symbol: "ANT",
      name: "aos",
      decimals: 12,
      type: "ant",
    },
    "cVe9EvLbiyE5s7l-rhS4zq03B-H93BVUHigDdkE6PdY": {
      symbol: "ANT",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    "k2pG6sAtAsSfaZmF7Y2a35uv7ufDn_M-O_pMmYt64RE": {
      symbol: "ANT",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    "LGN8MUAMvTvr6i-WGdXBu1z9jz01LZVnVwklp9z7D6U": {
      symbol: "ANT",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    NKWsqlsM9lUXxv97j3ANtzDmwKba7es1LHX3mLYCIB0: {
      symbol: "ANT",
      name: "aos",
      decimals: 12,
      type: "ant",
    },
    "oQ4GNTed8cnNw-H5olq606gCFd5MbGSV4NTmfpIW4FI": {
      symbol: "ANT",
      name: "ant-nov-13",
      decimals: 12,
      type: "ant",
    },
    LOhNBTsqTBWZYCCVp_6PqnYjlG_tKCrM1BhZZJxtQYI: {
      symbol: "ANT",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    AxHXaiKg7c4FAYZ5eo4OPAaEhmB0I0PRxLqzW6ZNHXk: {
      symbol: "ANT",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    "8SzSLuwy6EgYkTZLdrewi0etRwYxwHk2tUOlJicmFtE": {
      symbol: "ANT",
      name: "aos",
      decimals: 12,
      type: "ant",
    },
    YrlztzF8gvcAkgY7wAg5rHRrPSXdkHYDYK_zed_hUF8: {
      symbol: "ANT-AO",
      name: "ANT-ARDRIVE",
      decimals: 12,
      type: "ant",
    },
    "3gPV5_CBZXu9aV-ZKbLFNdFXaYSxxQaLYdnONYO8etQ": {
      symbol: "ANT-BLAAAAAAAAAAAAAAAAAH",
      name: "blaaaaaaaaaaaaaaaaah",
      decimals: 12,
      type: "ant",
    },
    lu9t8ku4szK8_BC3CBu3nJu5sRL75J_1L2J5ClarwAI: {
      symbol: "ANTssss",
      name: "aosss",
      decimals: 12,
      type: "ant",
    },
    X9ojTzcfO3x8t9b0EnaEiiiueY8ugJLzK0HHRrLEPvU: {
      symbol: "aos",
      name: "ANT",
      decimals: 12,
      type: "ant",
    },
    LlZjbmBv524nV5bW1MFavmA4q6nEqc7hqWmoEsNEwrI: {
      symbol: "aos",
      name: "ANT",
      decimals: 12,
      type: "ant",
    },
    _DjhFa0ISSuw8tp0xk_Q2Fttc8dU7WOrQirNi5nc5aQ: {
      symbol: "aos",
      name: "ANT",
      decimals: 12,
      type: "ant",
    },
    "2dmkkGNE1n583736zLjb6qQhsaZr5gEL5HPfBwP9V7s": {
      symbol: "aos",
      name: "ANTs",
      decimals: 12,
      type: "ant",
    },
    bTpw9b7M9G1EztEljJfCShDc2n5g3ORwywXO06V39ZM: {
      symbol: "aos",
      name: "ANT",
      decimals: 12,
      type: "ant",
    },
    ZMZuZGFo5WYEdAGsas9HfoIvq0M9QAUAVnAQy5icABk: {
      symbol: "aos",
      name: "ANT",
      decimals: 12,
      type: "ant",
    },
    "SGwy4xW9OvT0R8BLKM30qEWu5-ZHI9txtiOoODggbgA": {
      symbol: "aos",
      name: "ANT",
      decimals: 12,
      type: "ant",
    },
    "C8Xfj1K-kMe-vg9jE9P5mU5dY6lMU7eebXXCnoVTyqA": {
      symbol: "aos",
      name: "ANT",
      decimals: 12,
      type: "ant",
    },
    StaC96oXYXIrmP3my1b2nU70_UJKzQhlzJdrghb2IRM: {
      symbol: "aos",
      name: "ANT",
      decimals: 12,
      type: "ant",
    },
    "-5dkPUxcvr57veyN3WOBuL4V1YsnRGqj45Od5UwkqW8": {
      symbol: "aoss",
      name: "ANTs",
      decimals: 12,
      type: "ant",
    },

    // ─────────────────────────────────────────────────────────────
    // Invalid/Malformed ANT Tokens (no value)
    // ─────────────────────────────────────────────────────────────
    "OeHAboawG-JZJQ257DfS2F89vZpqL7DPq3KJyyQ2TBE": {
      symbol: "ANT-LIKE",
      name: "Invalid ANT Token",
      decimals: 12,
      type: "invalid",
    },
    "ra7kmy95f3sfAvH5lRxkP-XYczkmz6eLHuYciCxPpHY": {
      symbol: "ANT-LIKE",
      name: "Invalid ANT Token",
      decimals: 12,
      type: "invalid",
    },
    "LUZjgVXBNi2ftWOLRa6Xn0EEGLNH_xjbqN-yhoNx3Xs": {
      symbol: "ANT-LIKE",
      name: "Invalid ANT Token",
      decimals: 12,
      type: "invalid",
    },
    NlROmCJWVycjfZ5p4HYcjU_HDhMrinDu1J6SzG6wwjI: {
      symbol: "ANT-LIKE",
      name: "Invalid ANT Token",
      decimals: 12,
      type: "invalid",
    },

    // ─────────────────────────────────────────────────────────────
    // Unidentified Processes (historical, no token info available)
    // ─────────────────────────────────────────────────────────────
    mi1xx76SLM47RYJpwW3NE__OWRFhDFaJyxMsoTMGKHo: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "Pd1ZsBrv-AIbBHQIPfOAzabwcH0oB0zWNfzuLFP8aFg": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    rAX92TOCFY2JjPUXzx2l3v8HZUe1nwBTk2C1uPWdCxQ: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    xbGDKWAhLLEHDkCUDMyGt0kpy2UlrNZSjx8cxOyHay0: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    NHqPSba7MIJVLmwNeo5GgKCtXknuGxqsoh4Hi2PaxQo: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "EiD_B9mkFBHh1nqL-ZNkPPegOJVrSRa8qkend2ltQzg": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "BFCOqflIfHdWWGt47Hg-LejlvYHsB6CSrd7dyzX6JW8": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "1nwDcxTlek_0FIluh01BXfI4EMQcn1BM8AizYu24XI0": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "tfMj-ZiKKV1Q32Sb8HAm0nOVB-TfpzeAhygFhICIL5I": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    tSKDsgtWy5PWhREZ59NOrzPimeNbwr3CMkRrA5GY5tU: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "xREs3QcAzogaNYpi-NBsRktscdqj9WONJGaov6Qlfzo": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "AVREZoYshOzaEUyW-Wq-Si5IAssk6_p29fnNR6b0Vu0": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    m2vFCyq8XyHpPPki2hBwIdcfoW_jwbelQ49Dnp4UvaM: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "ZTe2Q2bb5jh3Atv-ZCcQIXclE0Z72Z4pIgCRV8dcOq8": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "5zARFslVTuk0BpocRknDarpIZ0lJsIgeZ-q38mwx7tg": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    "tyyrRX22hHjF3cW9zOz4AY2KG4xSGgefF49-nCCTwqA": {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    dcodF0DbVdzvRPE5nDTULn4aagHYruKnW3ulFkPkQC0: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    UmBk9VXL3kPpvQWfwsxoHKcmNxLLIuJCpPHdXkvyfO8: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    pDZuyrYctXOBXJgC6lmzz2fb6RiucoC3BpzOhmBJV5U: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
    c6MYvbqLLOy5BVbjHPQfRH5D3igJftIkjd_JZEzCvEc: {
      symbol: "UNIDENTIFIED",
      name: "Unidentified Process",
      decimals: 12,
      type: "unidentified",
    },
  },

  // ============================================================
  // Permaswap Configuration
  // ============================================================
  PERMASWAP: {
    POOL_FACTORY: "5G5_ftQT6f2OsmJ8EZ4-84eRcIMNEmUyH9aQSD85f9I",
    POOL_MODULE: "Do_Uc2Sju_ffp6Ev0AnLVdPtot15rvMjP-a9VVaA5fM",
    API_BASE: "https://api-ffpscan.permaswap.network",
    // Key tags for swaps
    SWAP_TAGS: {
      ACTION: "Order-Notice",
      ORDER_STATUS: "Swapped",
      USER_TAG: "User",
      POOL_ID_TAG: "PoolId",
    },
    // Known pools
    POOLS: {
      "FRF1k0BSv0gRzNA2n-95_Fpz9gADq9BGi5PyXKFp6r8": {
        name: "AO-wAR-100",
        tokenX: "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
        tokenY: "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10",
        fee: 100,
      },
      "gjnaCsEd749ZXeG2H8akvf8wzbl7CQ4Ox-KYEBAdONk": {
        name: "AO-wUSDC-100",
        tokenX: "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
        tokenY: "7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ",
        fee: 100,
      },
      T2r71KaJH15fpiyGD_RHsWqrIS1ccO7DZ7cm9g4HLRw: {
        name: "ARIO-AO-100",
        tokenX: "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE",
        tokenY: "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
        fee: 100,
      },
    },
  },

  // ============================================================
  // Botega/Dexi Configuration (shutting down but historical data available)
  // ============================================================
  BOTEGA: {
    AMM_FACTORY: "3XBGLrygs11K63F_7mldWz4veNx6Llg6hI2yZs8LKHo",
    AGENT_FACTORY: "x_WysdFwKD_buywRK9qLA7IexdlsvVTVq6ESWMRCzFY",
    STATUS: "maintenance", // Migrating to HyperBeam
    // Key tags for swaps
    SWAP_TAGS: {
      ACTION: "Order-Confirmation",
      DATA_PROTOCOL: "ao",
      TYPE: "Message",
      USER_TAG: "User",
    },
    // Agent confirmation tags
    AGENT_TAGS: {
      ACTION: "Botega-Order-Confirmation",
      ORDER_OWNER: "Order-Owner",
      AGENT_TYPE: "Agent-Type",
    },
    // Agent types
    AGENT_TYPES: ["limit-order", "stop-order", "dca-order"],
  },

  // ============================================================
  // Bazar UCM (Universal Content Marketplace) Configuration
  // ============================================================
  BAZAR: {
    // Known token orderbooks (token process ID -> orderbook info)
    ORDERBOOKS: {
      "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc": {
        orderbook: "lCRs8yNdib9l2FpAwSo8HFB3HZD9a-o50vnLkj0SEOc",
        symbol: "AO",
        decimals: 12,
      },
      "4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs": {
        orderbook: "IXVq2_AM8MFFRV2bUixgo7X2l8SBqE0pQbhZQQsvXCw",
        symbol: "PI",
        decimals: 12,
      },
      qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE: {
        orderbook: "cmJVjh6ADoTsrYWSwqztGt73sD4MOmE00l2fuT17vFU",
        symbol: "ARIO",
        decimals: 6,
      },
      "FBt9A5GA_KXMMSxA2DJ0xZbAq8sLLU2ak-YJe9zDvg8": {
        orderbook: "4SG5SuzBHGtkeGesqbDS7bZLgNABMuzCnBhdWD5Jp4w",
        symbol: "USDA",
        decimals: 12,
      },
      "DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo": {
        orderbook: "d1p2oTsZM8mZ-zR5m65VPK15qzqvGJjyor2Qhs0v7Es",
        symbol: "PIXL",
        decimals: 6,
      },
    },
    // Key tags for UCM trades
    UCM_TAGS: {
      ACTION: "Order-Success",
      STATUS: "Success",
      HANDLER: "Create-Order",
      DATA_PROTOCOL: "ao",
    },
  },

  // ============================================================
  // VentoSwap Bridge Configuration
  // ============================================================
  VENTO: {
    BRIDGE_ADDRESS: "mFRKcHsO6Tlv2E2wZcrcbv3mmzxzD7vYPbyybI3KCVA",
    VAR_TOKEN: "y-p7CPhs6JMUStAuE4KeTnMXN7qYBvEi2hiBFk8ZhjM",
    VUSDC_TOKEN: "cxkFiGP89fEKOvbvl9SLs1lEaw0L-DWJiqQOuDPeDG8",
    // Bridge tags
    BRIDGE_TAGS: {
      APP_NAME: "Vento-Bridge",
      ACTION_DEPOSIT: "BridgeARToVAR",
      ACTION_BURN: "Burn",
      FORWARD_WALLET: "Forward-Wallet",
    },
  },

  // ============================================================
  // Query Configuration
  // ============================================================
  QUERY: {
    BATCH_SIZE: 100,
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000,
    RATE_LIMIT_DELAY: 200, // ms between requests
    TIMEOUT: 30000, // 30 seconds
  },

  // ============================================================
  // Transaction Source Identifiers
  // ============================================================
  TRANSACTION_SOURCES: {
    AR_L1: "ar_l1",
    AO_TOKEN: "ao_token",
    PERMASWAP: "permaswap",
    BOTEGA: "botega",
    BAZAR: "bazar",
    AGENTS: "agents",
    VENTO_BRIDGE: "vento_bridge",
  },

  // ============================================================
  // Unified Transaction Types (for report generation)
  // These map to TaxClassification types
  // ============================================================
  UNIFIED_TX_TYPES: {
    // Acquisitions
    RECEIVE: "RECEIVE",
    TRADE_ACQUISITION: "TRADE_ACQUISITION",
    AIRDROP: "AIRDROP",
    MINING_REWARD: "MINING_REWARD",
    STAKING_REWARD: "STAKING_REWARD",
    GATEWAY_REWARD: "GATEWAY_REWARD",

    // Disposals
    SEND: "SEND",
    TRADE_DISPOSAL: "TRADE_DISPOSAL",
    DATA_UPLOAD: "DATA_UPLOAD",
    CONTRACT_INTERACTION: "CONTRACT_INTERACTION",

    // Non-taxable
    INTERNAL_TRANSFER: "INTERNAL_TRANSFER",
    BRIDGE_DEPOSIT: "BRIDGE_DEPOSIT",
    BRIDGE_WITHDRAWAL: "BRIDGE_WITHDRAWAL",

    // DEX-specific
    DEX_SWAP: "DEX_SWAP",
    ORDERBOOK_SALE: "ORDERBOOK_SALE",
    ORDERBOOK_PURCHASE: "ORDERBOOK_PURCHASE",

    // Unknown
    UNKNOWN: "UNKNOWN",
  },

  // ============================================================
  // Tax Event Categories
  // ============================================================
  TAX_CATEGORIES: {
    ACQUISITION: "ACQUISITION", // Receiving tokens (cost basis event)
    DISPOSAL: "DISPOSAL", // Sending tokens (taxable gain/loss)
    INCOME: "INCOME", // Airdrops, staking rewards, etc.
    EXPENSE: "EXPENSE", // Deductible expenses
    FEE_EXPENSE: "FEE_EXPENSE", // Transaction fees (can add to cost basis, not taxable)
    NON_TAXABLE: "NON_TAXABLE", // Internal transfers, no tax impact
  },
};
