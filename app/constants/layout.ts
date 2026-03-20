import { Dimensions } from 'react-native'

const { width, height } = Dimensions.get('window')

export const Screen = { width, height }

export const isSmall  = width < 375
export const isMedium = width >= 375 && width < 414
export const isLarge  = width >= 414

export const TAB_BAR_HEIGHT = 64
export const HEADER_HEIGHT   = 56
