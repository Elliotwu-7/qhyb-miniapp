/// <reference types="@dcloudio/types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

declare namespace UniNamespace {
  interface RequestOptions {
    useHighPerformanceMode?: boolean
  }
}
