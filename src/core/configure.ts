// What this app tells the shared modules about itself. Imported first, before
// anything that reads a number or builds a client.

import {configure} from '@zvm/web/config'
import {rpcUrl} from './endpoint'
import {chainName} from './chains'

configure({
  empty: '-',
  rpcUrl,
  appUrl: () => (typeof window === 'undefined' ? '' : `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}`),
  chainName,
})
