// Minimal typing for ssh2's internal list of algorithms supported by the current runtime.
declare module 'ssh2/lib/protocol/constants.js' {
  const constants: {
    SUPPORTED_KEX: string[]
    SUPPORTED_SERVER_HOST_KEY: string[]
    SUPPORTED_CIPHER: string[]
    SUPPORTED_MAC: string[]
    SUPPORTED_COMPRESSION: string[]
  }
  export default constants
}
