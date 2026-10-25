/**
 * What the gateway looks for, and how each kind of entity is treated (spec
 * section 5). Presidio supplies the built-in recognizers; MEDICAL_RECORD,
 * US_NPI and HEALTH_TERM come from the ad-hoc recognizers below, which are
 * sent with every /analyze request.
 */

/** One detected entity. Offsets are UTF-16 indices into the analysed text. */
export type Detected = { type: string; start: number; end: number; score: number };

/** Built-in Presidio entities replaced with <TYPE_N> and restored in answers. */
export const PERSONAL_ENTITIES = [
  "PERSON",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "IN_AADHAAR",
  "IN_PAN",
  "US_SSN",
  "IP_ADDRESS",
  "IBAN_CODE",
  "US_PASSPORT",
  "US_DRIVER_LICENSE",
  "CRYPTO",
] as const;
/**
 * Extra personal data, each switched by the gateway's --extra-entities flag
 * (DEFAULT_EXTRA_GROUPS below by default). Detecting is what the flag switches: these types are
 * always masked when found, so a client placeholder like <C_BANK_ACCOUNT_1>
 * still counts as personal data.
 *   bank_account    BANK_ACCOUNT    account-number shapes (ad-hoc recognizer)
 *   titled_name     PERSON          MR/MRS/DR/SHRI/SMT + name, a second PERSON signal beside the NLP model
 *   street_address  STREET_ADDRESS  house number + street word (ad-hoc recognizer)
 *   dob             DATE_OF_BIRTH   a date next to "date of birth", "DOB" or "born" (other dates stay: the model needs them)
 *   location        LOCATION        Presidio's built-in place names (cities, countries)
 */
export const EXTRA_ENTITY_GROUPS = ["bank_account", "titled_name", "street_address", "dob", "location"] as const;
export type ExtraEntityGroup = (typeof EXTRA_ENTITY_GROUPS)[number];
/**
 * On unless --extra-entities says otherwise. "location" is left out: a city or
 * country alone rarely identifies anyone, and masking it breaks ordinary
 * questions ("What is the capital of India?" reached the model as
 * "<LOCATION_1>"). Street addresses stay covered by street_address.
 */
export const DEFAULT_EXTRA_GROUPS: readonly ExtraEntityGroup[] = ["bank_account", "titled_name", "street_address", "dob"];
export const EXTRA_PERSONAL_ENTITIES = ["BANK_ACCOUNT", "STREET_ADDRESS", "DATE_OF_BIRTH", "LOCATION"] as const;

/** Replaced with [CARD REMOVED] and never restored. Presidio checks the Luhn digit. */
export const CARD_ENTITIES = ["CREDIT_CARD"] as const;
/** Replaced with <TYPE_N>; any one of them makes the text PHI. */
export const MEDICAL_ID_ENTITIES = ["MEDICAL_LICENSE", "MEDICAL_RECORD", "US_NPI"] as const;
/** Conditions, drugs and procedures: left in place (the model needs them) and used only to classify. */
export const HEALTH_TERM = "HEALTH_TERM";

/** Entity types requested from Presidio with no extra groups. DATE_TIME (any date), NRP and URL are never requested. */
export const BASE_DETECTED_ENTITIES: readonly string[] = [...PERSONAL_ENTITIES, ...CARD_ENTITIES, ...MEDICAL_ID_ENTITIES, HEALTH_TERM];

/** Built-in Presidio entities the gateway refuses to run without (checked at start-up, V4). */
export const REQUIRED_PRESIDIO_ENTITIES: readonly string[] = [...PERSONAL_ENTITIES, ...CARD_ENTITIES, "MEDICAL_LICENSE"];

const PERSONAL = new Set<string>([...PERSONAL_ENTITIES, ...EXTRA_PERSONAL_ENTITIES]);
const MEDICAL_ID = new Set<string>(MEDICAL_ID_ENTITIES);

export const isPersonal = (type: string): boolean => PERSONAL.has(type);
export const isCard = (type: string): boolean => type === "CREDIT_CARD";
export const isMedicalId = (type: string): boolean => MEDICAL_ID.has(type);
export const isHealthTerm = (type: string): boolean => type === HEALTH_TERM;
/** Types that become numbered placeholders. */
export const isMasked = (type: string): boolean => PERSONAL.has(type) || MEDICAL_ID.has(type);

/**
 * ChainAim's health-term list, matched as whole words in any case. Ambiguous
 * abbreviations (AIDS, STD, STI) are left out: "std::vector" in a coding
 * question must not make a request PHI.
 */
export const HEALTH_TERMS: readonly string[] = [
  // conditions
  "diabetes", "diabetic", "hypertension", "high blood pressure", "asthma", "cancer", "tumor", "tumour",
  "leukemia", "lymphoma", "HIV", "hepatitis", "tuberculosis", "pneumonia", "COVID-19", "depression",
  "anxiety disorder", "bipolar disorder", "schizophrenia", "PTSD", "ADHD", "autism", "dementia",
  "Alzheimer's", "Parkinson's", "epilepsy", "seizure", "stroke", "heart attack", "heart failure",
  "arrhythmia", "chest pain", "migraine", "arthritis", "lupus", "multiple sclerosis", "kidney disease",
  "cirrhosis", "obesity", "pregnant", "pregnancy", "miscarriage", "infertility", "overdose", "addiction",
  "opioid use disorder", "eating disorder", "anorexia", "chlamydia", "syphilis", "herpes",
  // drugs
  "insulin", "metformin", "lisinopril", "atorvastatin", "amlodipine", "sertraline", "fluoxetine",
  "prozac", "xanax", "adderall", "oxycodone", "methadone", "buprenorphine", "warfarin", "prednisone",
  // procedures and care
  "chemotherapy", "radiotherapy", "dialysis", "biopsy", "mastectomy", "transplant", "surgery",
  "inhaler", "diagnosed", "diagnosis", "prescribed", "prescription",
];

export type AdHocRecognizer = {
  name: string;
  supported_language: "en";
  supported_entity: string;
  patterns?: { name: string; regex: string; score: number }[];
  context?: string[];
  deny_list?: readonly string[];
};

/**
 * Sent with every /analyze call. A pattern scored 0.1 passes the 0.4
 * threshold only when Presidio finds a context word near it (+0.35, floor
 * 0.4), which is how "needs a context word" is expressed.
 */
export const BASE_AD_HOC_RECOGNIZERS: readonly AdHocRecognizer[] = [
  {
    name: "ChainAim medical record number",
    supported_language: "en",
    supported_entity: "MEDICAL_RECORD",
    patterns: [{ name: "mrn (needs context)", regex: "\\b[A-Z]{0,3}\\d{6,10}\\b", score: 0.1 }],
    context: ["mrn", "medical", "record"],
  },
  {
    name: "ChainAim NPI",
    supported_language: "en",
    supported_entity: "US_NPI",
    patterns: [{ name: "npi (needs context)", regex: "\\b[12]\\d{9}\\b", score: 0.1 }],
    context: ["npi"],
  },
  { name: "ChainAim health terms", supported_language: "en", supported_entity: HEALTH_TERM, deny_list: HEALTH_TERMS },
];

/**
 * Ad-hoc recognizers for the extra groups. Presidio's pattern recognizers
 * match without regard to case, so the patterns are written in lower case.
 * A pattern scored 0.1 needs a context word (see above); one scored 0.6
 * stands on its own.
 */
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const STREET_WORD = "(?:street|st|road|rd|avenue|ave|lane|ln|drive|place|pl|crescent|cres|terrace|tce|boulevard|blvd|highway|hwy|nagar|marg|salai)";
export const EXTRA_AD_HOC_RECOGNIZERS: Readonly<Record<Exclude<ExtraEntityGroup, "location">, AdHocRecognizer>> = {
  bank_account: {
    name: "ChainAim bank account number",
    supported_language: "en",
    supported_entity: "BANK_ACCOUNT",
    patterns: [
      // NZ-style bank-branch-account-suffix, e.g. 12-3456-7890123-00: specific enough on its own
      { name: "nz account", regex: "\\b\\d{2}-\\d{4}-\\d{7}-\\d{2,3}\\b", score: 0.6 },
      // grouped digits (BSB 062-000 12345678, sort code 20-00-00 12345678): needs a context word
      { name: "grouped account (needs context)", regex: "\\b\\d{2,6}(?:[- ]\\d{2,10}){1,3}\\b", score: 0.1 },
      // a plain run of 6 to 18 digits: needs a context word
      { name: "plain account (needs context)", regex: "\\b\\d{6,18}\\b", score: 0.1 },
    ],
    context: ["account", "acct", "a/c", "ac", "acc", "bsb", "ifsc", "sort", "routing", "bank", "iban"],
  },
  titled_name: {
    name: "ChainAim titled name",
    supported_language: "en",
    supported_entity: "PERSON",
    // MR AB SAMPLEPERSON, Mrs C Samplename, Dr. A. Kumar, Shri Ravi Shankar: a title, up to three initials, then one or two name words
    patterns: [{ name: "title + name", regex: "\\b(?:mr|mrs|miss|dr|shri|smt|ms\\.)\\.?\\s+(?:[a-z]\\.?\\s+){0,3}[a-z][a-z'-]+(?:\\s+[a-z][a-z'-]+)?\\b", score: 0.6 }],
  },
  street_address: {
    name: "ChainAim street address",
    supported_language: "en",
    supported_entity: "STREET_ADDRESS",
    // 42 Rosewood Avenue, 7B Gandhi Nagar, Flat 3, 15 MG Road
    patterns: [{ name: "number + street", regex: `\\b\\d{1,5}[a-z]?,?\\s+(?:[a-z][a-z'-]*\\s+){0,3}${STREET_WORD}\\b\\.?`, score: 0.5 }],
  },
  dob: {
    name: "ChainAim date of birth",
    supported_language: "en",
    supported_entity: "DATE_OF_BIRTH",
    patterns: [
      { name: "d/m/y (needs context)", regex: "\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b", score: 0.1 },
      { name: "y-m-d (needs context)", regex: "\\b\\d{4}-\\d{2}-\\d{2}\\b", score: 0.1 },
      { name: "d month y (needs context)", regex: `\\b\\d{1,2}\\s+${MONTH}\\s+\\d{4}\\b`, score: 0.1 },
      { name: "month d, y (needs context)", regex: `\\b${MONTH}\\s+\\d{1,2},?\\s+\\d{4}\\b`, score: 0.1 },
    ],
    context: ["dob", "d.o.b", "birth", "born", "birthday"],
  },
};

/** What the gateway asks Presidio for, and what the start-up check expects back. */
export type Detection = {
  groups: readonly ExtraEntityGroup[];
  entities: readonly string[];
  recognizers: readonly AdHocRecognizer[];
  /** Built-in Presidio entities the gateway refuses to run without. */
  required: readonly string[];
  /** The start-up test sentence and, for each value in it, the types that count as detecting it. */
  canary: { text: string; expect: readonly { value: string; types: readonly string[] }[] };
};

/**
 * Start-up test sentence, from synthetic values (scripts/synthetic-corpus.ts).
 * The name needs the NLP model, the e-mail is a pattern, and the record
 * number needs ChainAim's ad-hoc recognizer and its context word "MRN".
 */
const BASE_CANARY = { text: "Patient Jane Roe, MRN 991122, can be reached at jane.roe@example.com.", expect: [
  { value: "Jane Roe", types: ["PERSON"] },
  { value: "jane.roe@example.com", types: ["EMAIL_ADDRESS"] },
  { value: "991122", types: ["MEDICAL_RECORD"] },
] };
const EXTRA_CANARY: Readonly<Record<ExtraEntityGroup, { text: string; value: string; types: string[] }>> = {
  bank_account: { text: "Account 12-3456-7890123-00.", value: "12-3456-7890123-00", types: ["BANK_ACCOUNT"] },
  titled_name: { text: "Statement for MR AB SAMPLEPERSON.", value: "SAMPLEPERSON", types: ["PERSON"] },
  street_address: { text: "Post to 42 Rosewood Avenue.", value: "Rosewood", types: ["STREET_ADDRESS", "LOCATION"] },
  dob: { text: "Date of birth 14/03/1981.", value: "14/03/1981", types: ["DATE_OF_BIRTH"] },
  location: { text: "Branch in London.", value: "London", types: ["LOCATION"] },
};

/** The detection set for the chosen extra groups (default: DEFAULT_EXTRA_GROUPS). */
export function detection(groups: readonly ExtraEntityGroup[] = DEFAULT_EXTRA_GROUPS): Detection {
  const on = new Set(groups);
  const entities = [...BASE_DETECTED_ENTITIES];
  if (on.has("bank_account")) entities.push("BANK_ACCOUNT");
  if (on.has("street_address")) entities.push("STREET_ADDRESS");
  if (on.has("dob")) entities.push("DATE_OF_BIRTH");
  if (on.has("location")) entities.push("LOCATION");
  const recognizers = [...BASE_AD_HOC_RECOGNIZERS];
  for (const g of ["bank_account", "titled_name", "street_address", "dob"] as const) if (on.has(g)) recognizers.push(EXTRA_AD_HOC_RECOGNIZERS[g]);
  const required = [...REQUIRED_PRESIDIO_ENTITIES, ...(on.has("location") ? ["LOCATION"] : [])];
  const extras = EXTRA_ENTITY_GROUPS.filter((g) => on.has(g)).map((g) => EXTRA_CANARY[g]);
  return {
    groups: EXTRA_ENTITY_GROUPS.filter((g) => on.has(g)),
    entities,
    recognizers,
    required,
    canary: {
      text: [BASE_CANARY.text, ...extras.map((e) => e.text)].join(" "),
      expect: [...BASE_CANARY.expect, ...extras.map((e) => ({ value: e.value, types: e.types }))],
    },
  };
}

/** Parse a comma-separated --extra-entities value: group names, "default", "all" or "none". */
export function parseExtraGroups(value: string): ExtraEntityGroup[] {
  const v = value.trim().toLowerCase();
  if (v === "default") return [...DEFAULT_EXTRA_GROUPS];
  if (v === "all") return [...EXTRA_ENTITY_GROUPS];
  if (v === "none" || v === "") return [];
  const out: ExtraEntityGroup[] = [];
  for (const part of v.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!(EXTRA_ENTITY_GROUPS as readonly string[]).includes(part)) throw new Error(`--extra-entities: unknown group ${part}; use all, none or ${EXTRA_ENTITY_GROUPS.join(",")}`);
    if (!out.includes(part as ExtraEntityGroup)) out.push(part as ExtraEntityGroup);
  }
  return out;
}

/** The default detection set: DEFAULT_EXTRA_GROUPS on. */
export const DEFAULT_DETECTION: Detection = detection();
/** Kept for callers that read the lists directly; they follow the default detection set. */
export const DETECTED_ENTITIES: readonly string[] = DEFAULT_DETECTION.entities;
export const AD_HOC_RECOGNIZERS: readonly AdHocRecognizer[] = DEFAULT_DETECTION.recognizers;
