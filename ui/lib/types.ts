// Shapes mirrored from the shubham_agent FastAPI backend (app.py).

export interface DbRow {
  id: string;
  file_name: string;
  data_file_name: string;
  start_url: string;
}

export interface ScriptListItem {
  name: string;
  py_key: string;
  params_key: string;
  has_db: boolean;
}

export interface ScriptsResponse {
  bucket: string;
  scripts: ScriptListItem[];
}

export type ParamRow = Record<string, string>;

export interface RecordingConfig {
  version?: number;
  recording_name?: string;
  prompt?: string;
  repeatable_blocks?: Array<{
    enabled?: boolean;
    sheet_name?: string;
    match_key?: string;
    prompt?: string;
  }>;
}

export interface ScriptDetail {
  name: string;
  py_key: string;
  py_text: string;
  params_key: string;
  params: ParamRow[];
  placeholders: string[];
  db: DbRow | null;
  recording_config: RecordingConfig;
  line_items: ParamRow[];
  // The workbook's ORIGINAL bytes (base64), set only by the platform loader.
  // Kept so an unedited recording can be staged for the local worker byte for
  // byte instead of rebuilt from the parsed rows -- a rebuild is not lossless
  // (see params_b64 in app.py's UploadBody).
  params_b64?: string;
}

export interface UploadResult {
  ok: boolean;
  bucket: string;
  name: string;
  py_key: string;
  params_key: string;
  start_url: string;
  param_rows: number;
  missing_placeholders: string[];
  multi_line_row_count: number;
  params_verbatim?: boolean;
  recording_config_key: string;
  db: { id?: string | null; inserted?: boolean; conflict?: boolean };
  db_error: string;
  run_cmd: string;
}

export interface RunResult {
  ok: boolean;
  returncode: number;
  cmd: string;
  stdout: string;
  stderr: string;
  report_key: string;
  report_local: string;
  report_url: string;
  used_after_action_wait_ms: number;
  execution_mode: string;
  // single-run extras
  inline_parameter_keys?: string[];
  inline_multi_line_row_count?: number;
  prepared_recording_count?: number;
  prepared_recording_names?: string[];
  // suite extras
  suite_id?: string;
  recordings?: string[];
}

export interface AppConfig {
  bucket: string;
  storage_endpoint: string;
  aetherion_bin: string;
  test_runner_dir: string;
  pg: { host: string; port: number; db: string };
  default_after_action_wait_ms: number;
}

export type ExecutionMode = "parallel" | "sequential";

// ---- Local file-DB entities (act_ui/localdb) ------------------------------
export interface SuiteGraph {
  nodes: unknown[];
  edges: unknown[];
}

export interface Suite {
  id: string;
  name: string;
  execution_mode: ExecutionMode;
  members: string[]; // ordered recording names
  graph?: SuiteGraph; // optional canvas snapshot so the designer can restore it
  created_at: string;
  updated_at: string;
}

export interface SuiteInput {
  name: string;
  execution_mode?: ExecutionMode;
  members?: string[];
  graph?: SuiteGraph;
}

