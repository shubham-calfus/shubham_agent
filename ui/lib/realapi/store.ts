import { configureStore } from "@reduxjs/toolkit";
import connectionReducer from "./connectionSlice";
import { realApi } from "./realApi";

export const makeStore = () =>
  configureStore({
    reducer: {
      connection: connectionReducer,
      [realApi.reducerPath]: realApi.reducer,
    },
    middleware: (getDefault) => getDefault().concat(realApi.middleware),
  });

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];
