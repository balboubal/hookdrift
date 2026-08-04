/** JSON value types we track. `null` is tracked separately as `nullable`, never as a type. */
export type JsonType = "string" | "number" | "boolean" | "object" | "array";

export interface FieldSchema {
  /** Observed JSON types at this path, sorted. Never includes "null". */
  types: JsonType[];
  /** True if null was ever observed at this path. */
  nullable?: boolean;
  /** samplesContainingPath / totalSamples. 1.0 means required. */
  presence: number;
  /** Conservative format claim — only set when every observed value matched. */
  format?: string;
  /** Only meaningful for number paths: every observed number was an integer. */
  intOnly?: boolean;
  /** Enum claim: distinct value set (strings only, ≤ 12 distinct across ≥ 30 observed values). */
  enum?: string[];
  enumConfidence?: number;
  /**
   * Field legitimately arrives in more than one shape (e.g. Stripe expandable
   * fields: an ID string or the expanded object, controlled by the consumer's
   * own request params). Type widening on such a field is INFO, narrowing is
   * WARNING. Set automatically by infer when both shapes are observed and the
   * strings are ID-like, or by hand in the contract file.
   */
  polymorphic?: boolean;
}

export interface Contract {
  version: 1;
  provider: string;
  event: string;
  samplesObserved: number;
  firstSeen: string;
  lastUpdated: string;
  fields: Record<string, FieldSchema>;
}

/**
 * In-memory aggregate of a batch of samples for one provider/event.
 * Holds structure only — the `distinct` sets exist so enums can be claimed,
 * and are dropped as soon as cardinality exceeds the enum threshold.
 */
export interface PathStats {
  types: Set<JsonType>;
  nullable: boolean;
  /** Number of null occurrences observed at this path. */
  nullCount: number;
  /** Number of samples in which this path appeared at least once. */
  containCount: number;
  /** Number of non-null values observed at this path (occurrences, incl. array elements). */
  valueCount: number;
  /** Number of string values observed. */
  stringCount: number;
  /** Distinct string values; null once cardinality exceeds the enum cap. */
  distinct: Set<string> | null;
  /** Intersection of format candidates across all observed values; null = no value seen yet. */
  formatCandidates: Set<string> | null;
  /** Every observed string matched the ID-like pattern (meaningless if stringCount is 0). */
  allIdLike: boolean;
  /** Every observed number was an integer. Meaningless until a number is seen. */
  intOnly: boolean;
  sawNumber: boolean;
}

export interface Observation {
  totalSamples: number;
  paths: Map<string, PathStats>;
}

export type Severity = "BREAKING" | "WARNING" | "INFO";

export type FindingKind =
  | "path_removed"
  | "path_moved"
  | "type_changed"
  | "became_nullable"
  | "enum_value_removed"
  | "array_scalar_flip"
  | "required_became_optional"
  | "enum_value_added"
  | "format_changed"
  | "precision_shift"
  | "new_field"
  | "presence_shift"
  | "uncontracted_event"
  | "invalid_contract"
  | "skipped_fixture";

export interface CodeRef {
  file: string;
  line: number;
  /** How much of the changed path matched at this location (0..1], used for ranking. */
  score: number;
}

export interface Finding {
  provider: string;
  event: string;
  path: string;
  severity: Severity;
  kind: FindingKind;
  /** Human-readable description including sample-count evidence. */
  message: string;
  movedTo?: string;
  refs?: CodeRef[];
  /** Matched an ignore rule. Suppressed findings are kept in last-run.json and counted, never dropped. */
  suppressed?: boolean;
  suppressReason?: string;
}

export interface IgnoreRule {
  /** Dotted path; `*` (trailing) matches one segment, `**` (trailing) matches any depth. */
  path: string;
  /** If omitted, all finding kinds at the path are suppressed. */
  kind?: FindingKind;
  /** Purely documentary. */
  reason?: string;
}

export interface HookdriftConfig {
  contractsDir: string;
  providers: Record<string, { fixtures: string; eventPath: string }>;
  source: string[];
  strict: boolean;
  /** Below this many new samples, presence-based findings are downgraded to INFO. */
  minSamples: number;
  /** Fail the run when a matched fixture could not be parsed or had no event. */
  failOnSkipped: boolean;
  /** Fail the run when fixtures contain an event with no committed contract. */
  failOnUncontracted: boolean;
  ignore: IgnoreRule[];
}
