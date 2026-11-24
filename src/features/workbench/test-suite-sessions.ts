import { createContext, type Dispatch, type SetStateAction } from "react";

export type TestSuiteSessions = {
  unresolvedSessions: ReadonlySet<string>;
  onUnresolvedSessionsChange: Dispatch<SetStateAction<ReadonlySet<string>>>;
};

export const TestSuiteSessionsContext = createContext<TestSuiteSessions | null>(
  null,
);
