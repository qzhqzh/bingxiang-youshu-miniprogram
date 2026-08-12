declare module 'node:assert/strict' {
  const assert: any;
  export default assert;
}

declare module 'node:test' {
  export const describe: any;
  export const it: any;
}
