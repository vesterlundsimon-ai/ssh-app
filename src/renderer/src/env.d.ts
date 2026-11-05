import type { SimSSHApi } from '../../preload/index'

declare global {
  interface Window {
    api: SimSSHApi
  }
}

export {}
