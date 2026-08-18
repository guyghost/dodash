declare module "tau-prolog" {
  interface CallbackSet {
    readonly success: (value?: unknown) => void;
    readonly error: (error: unknown) => void;
  }

  interface AnswerCallbacks {
    readonly success: (answer: unknown) => void;
    readonly error: (error: unknown) => void;
    readonly fail: () => void;
    readonly limit: () => void;
  }

  interface Session {
    consult(program: string, callbacks: CallbackSet): void;
    query(goal: string, callbacks: CallbackSet): void;
    answer(callbacks: AnswerCallbacks): void;
    format_answer(answer: unknown): string;
  }

  interface TauProlog {
    create(limit?: number): Session;
  }

  const prolog: TauProlog;
  export default prolog;
}

