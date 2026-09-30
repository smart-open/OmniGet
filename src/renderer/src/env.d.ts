/// <reference types="vite/client" />

declare global {
  interface Window {
    omniget: import('@shared/types').OmniGetBridge
  }
}

export {}
