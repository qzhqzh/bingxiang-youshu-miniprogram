declare const wx: any;
declare const console: { error(...values: unknown[]): void; log(...values: unknown[]): void };
declare function setTimeout(callback: () => void, delay?: number): number;
interface WechatInstance { data: any; setData(value: Record<string, unknown>, callback?: () => void): void; triggerEvent(name: string, detail?: unknown): void; }
declare function App<T extends Record<string, unknown>>(options: T & ThisType<T>): void;
declare function Page<T extends Record<string, unknown>>(options: T & ThisType<T & WechatInstance>): void;
declare function Component<T extends Record<string, unknown>>(options: T & ThisType<T & WechatInstance>): void;
declare function getCurrentPages(): any[];
