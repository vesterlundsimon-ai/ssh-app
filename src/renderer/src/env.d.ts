import type { ShellportApi } from '../../preload/index'

declare global {
  interface Window {
    api: ShellportApi
  }
}

export {}
