import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from "@reduxjs/toolkit/query/react";
import type { RootState } from "./store";
import { platformPrefix } from "./connectionSlice";

export interface PlatformRecording {
  id: string;
  name: string;
  start_url?: string;
  [key: string]: unknown;
}

export interface RecordedFlowRef {
  id: string;
  name: string;
  file_path?: string;
  data_file_path?: string;
}

// milkyway's TestSuiteRecordedFlowsSchema: file_path = the .py the runner
// executes, data_file_path = the params workbook. recorded-flow-list does NOT
// carry these, so a suite lookup is the only authoritative source for the keys.
export interface TestSuite {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  recorded_flows?: RecordedFlowRef[]; // suite members
  [key: string]: unknown;
}

// The base URL (which /rapi/<prefix> prefix) and the auth headers depend on the
// current connection state, so we build fetchBaseQuery per request.
const dynamicBaseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  apiObj,
  extraOptions,
) => {
  const { source, token, realm } = (apiObj.getState() as RootState).connection;
  const prefix = platformPrefix(source);
  // Callers skip these queries when the source is the local runner. If one ever
  // fires anyway, fail loudly rather than requesting a nonexistent /rapi/ route.
  if (!prefix) {
    return {
      error: {
        status: "CUSTOM_ERROR",
        error: "No platform selected — the local runner is served by app.py, not the platform API.",
      } as FetchBaseQueryError,
    };
  }
  const raw = fetchBaseQuery({
    baseUrl: `/rapi/${prefix}/`,
    prepareHeaders: (headers) => {
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (realm) headers.set("x-realm-id", realm);
      headers.set("accept", "application/json");
      return headers;
    },
  });
  return raw(args, apiObj, extraOptions);
};

function normalizeList<T>(resp: unknown, keys: string[]): T[] {
  if (Array.isArray(resp)) return resp as T[];
  if (resp && typeof resp === "object") {
    for (const key of keys) {
      const value = (resp as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

export const realApi = createApi({
  reducerPath: "realApi",
  baseQuery: dynamicBaseQuery,
  tagTypes: ["TestSuite", "RecordedFlow"],
  endpoints: (builder) => ({
    getTestSuites: builder.query<TestSuite[], void>({
      query: () => "test-suite-list",
      transformResponse: (resp: unknown) =>
        normalizeList<TestSuite>(resp, ["data", "items", "results", "test_suites", "testSuites", "suites"]),
      providesTags: ["TestSuite"],
    }),
    // Fetch one file's bytes out of the platform's object storage, so a platform
    // recording can be shown, edited and run LOCALLY.
    //
    // The parameter is `filename` and it takes the FULL S3 key: milkyway's
    // src/routes/kb/download.py does `storage.client.get_object(Bucket=get_tenant_id(),
    // Key=filename)`. (Guessing key/path/file_path/... returns 422 — the earlier
    // candidate-probing loop is gone now that the signature is known.)
    downloadPlatformFile: builder.mutation<string, { path: string }>({
      query: ({ path }) => ({
        url: `download?filename=${encodeURIComponent(path)}`,
        responseHandler: "text",
      }),
    }),
    // Same route, for the params workbook: base64 so app.py's /api/parse-params
    // can read it without a JS xlsx parser.
    downloadPlatformFileB64: builder.mutation<string, { path: string }>({
      query: ({ path }) => ({
        url: `download?filename=${encodeURIComponent(path)}`,
        responseHandler: async (response) => {
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return btoa(binary);
        },
      }),
    }),
    getRecordedFlows: builder.query<PlatformRecording[], void>({
      query: () => "recorded-flow-list",
      transformResponse: (resp: unknown) =>
        normalizeList<PlatformRecording>(resp, [
          "data",
          "items",
          "results",
          "recorded_flows",
          "recordedFlows",
          "recordings",
          "flows",
        ]),
      providesTags: ["RecordedFlow"],
    }),
  }),
});

export const {
  useGetTestSuitesQuery,
  useGetRecordedFlowsQuery,
  useDownloadPlatformFileMutation,
  useDownloadPlatformFileB64Mutation,
} = realApi;
