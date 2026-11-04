import type { TeamRole } from '../../../lib/meta-experience/team-model'
import type { PixelLayer } from './muse-pixels'

/**
 * Muebles de la oficina en pixel art, en el mismo formato de capas que las
 * Muses. Cada ambiente pone muebles detrás y delante de su Muse.
 */
export const PROP_PALETTE: Record<string, string> = {
  d: '#5e3f28', // madera oscura
  D: '#8d5f3c', // madera
  h: '#c0504d', // libro rojo
  j: '#4f9d69', // libro verde
  q: '#4a78c2', // libro azul
  G: '#6b7280', // marco gris
  W: '#e9edf2', // pizarra y lienzo
  Y: '#f6d55c', // nota amarilla
  P: '#f28fad', // nota rosa
  B: '#7cc3f2', // nota azul
  M: '#22262e', // monitor
  S: '#3fb6a8', // pantalla
  R: '#ef476f', // barra roja
  V: '#06d6a0', // barra verde
  U: '#3d6fb6', // plano
  u: '#a9c4ee', // trazo del plano
  K: '#a3794f', // tablero perforado
  T: '#c4ccd6', // herramienta
  x: '#c08a4b', // caja
  X: '#8d6748', // cinta
  A: '#3a7d44', // planta
  Q: '#2f5aa8', // mostrador
  L: '#ffd166', // lámpara
}

export interface Prop {
  rows: PixelLayer
  x: number
  y: number
}

const BOOKSHELF: PixelLayer = [
  'dddddddddd',
  'dhqjhqjhqd',
  'dhqjhqjhqd',
  'dddddddddd',
  'dqjhjqhjqd',
  'dqjhjqhjqd',
  'dddddddddd',
  'djhqqjhhjd',
  'djhqqjhhjd',
  'dddddddddd',
  'd........d',
  'dddddddddd',
]

const WHITEBOARD: PixelLayer = [
  'GGGGGGGGGGGGGG',
  'GWWWWWWWWWWWWG',
  'GWYYWPPWWBBWWG',
  'GWYYWPPWWBBWWG',
  'GWWWWWWWYYWWWG',
  'GWBBWWYYWYYWWG',
  'GWBBWWYYWWWWWG',
  'GGGGGGGGGGGGGG',
  '.G..........G.',
]

const DESK_MONITOR: PixelLayer = [
  '....MMMMMM....',
  '....MSSSSM....',
  '....MSSSSM....',
  '....MMMMMM....',
  '......MM......',
  'DDDDDDDDDDDDDD',
  'dDDDDDDDDDDDDd',
  'd............d',
]

const DATA_DESK: PixelLayer = [
  'MMMMMM....MMMMMM',
  'MSRSSM....MSSVSM',
  'MRRVSM....MSVVRM',
  'MMMMMM....MMMMMM',
  '..MM........MM..',
  'DDDDDDDDDDDDDDDD',
  'dDDDDDDDDDDDDDDd',
  'd..............d',
]

const BLUEPRINT: PixelLayer = [
  'UUUUUUUUUUUUUU',
  'UuUUUuUUUUuUUU',
  'UuuuuuUUuuuuUU',
  'UUUUuUUUUuUUUU',
  'DDDDDDDDDDDDDD',
  'd............d',
  'd............d',
]

const TOOLBOARD: PixelLayer = [
  'KKKKKKKKKKKK',
  'KTKKTKKKTTKK',
  'KTKTTTKKTTKK',
  'KTKKTKKKKTKK',
  'KKKKKKKKKKKK',
  'KKTTKKTKKKKK',
  'KKTTKTTTKKKK',
  'KKKKKKKKKKKK',
]

const EASEL: PixelLayer = [
  '...ddd...',
  '.WWWWWWW.',
  '.WRRWBBW.',
  '.WRYYBBW.',
  '.WWYYVVW.',
  '.WWWWVVW.',
  '.WWWWWWW.',
  '...d.d...',
  '..d...d..',
  '.d.....d.',
]

const RACK: PixelLayer = [
  'G............G',
  'GxxxX..xxxX..G',
  'GxxxX..xxxX..G',
  'GGGGGGGGGGGGGG',
  'G..xxxXxxxX..G',
  'G..xxxXxxxX..G',
  'GGGGGGGGGGGGGG',
  'GxxxXxxxX....G',
  'GxxxXxxxX....G',
  'GGGGGGGGGGGGGG',
  'G............G',
]

const BOXES: PixelLayer = ['..xxxX..', '..xxxX..', 'xxxXxxxX', 'xxxXxxxX']

const BIG_SCREEN: PixelLayer = [
  'MMMMMMMMMMMMMMMMMMMM',
  'MSSSSSSSSSSSSSSSSSSM',
  'MSVVSSRRSSYYSSBBSSSM',
  'MSVVSSRRSSYYSSBBSSSM',
  'MSSSSSSSSSSSSSSSSSSM',
  'MMMMMMMMMMMMMMMMMMMM',
]

const COUNTER: PixelLayer = [
  'GGGGGGGGGGGGGGGGGGGGGGGG',
  'QQQQQQQQQQQQQQQQQQQQQQQQ',
  'QQQQQQQQQQQQQQQQQQQQQQQQ',
  'QQQQQQQQQQQQQQQQQQQQQQQQ',
  'QQQQQQQQQQQQQQQQQQQQQQQQ',
]

const PLANT: PixelLayer = ['.A.A.', 'AAAAA', '.AAA.', '..A..', '.ddd.', '.ddd.']

const LAMP: PixelLayer = ['.LLL.', 'LLLLL', '..d..', '..d..', '..d..', '.ddd.']

const TABLE: PixelLayer = [
  'DDDDDDDDDDDDDD',
  'dDDDDDDDDDDDDd',
  'd............d',
  'd............d',
]

const SOFA: PixelLayer = [
  '..PPPPPPPPPPPPPPPP..',
  '.PPPPPPPPPPPPPPPPPP.',
  'PPhhhhhhhhhhhhhhhhPP',
  'PPhhhhhhhhhhhhhhhhPP',
  'PPPPPPPPPPPPPPPPPPPP',
  '.d................d.',
]

const COFFEE: PixelLayer = [
  'MMMMMM',
  'MSSSSM',
  'MMMMMM',
  'MM..MM',
  'MMWWMM',
  'MMMMMM',
  'dddddd',
  'd....d',
  'd....d',
]

const RUG: PixelLayer = [
  '..BBBBBBBBBBBBBBBBBBBB..',
  'BBBBBBBBBBBBBBBBBBBBBBBB',
  '..BBBBBBBBBBBBBBBBBBBB..',
]

/** Sala de descanso: decorativa, llena la fila junto a la bodega. */
export const LOUNGE = {
  width: 80 as const,
  wall: '#2f2a33',
  floor: '#241f27',
  props: [
    { rows: PLANT, x: 4, y: 15 },
    { rows: COFFEE, x: 12, y: 12 },
    { rows: SOFA, x: 30, y: 15 },
    { rows: RUG, x: 28, y: 22 },
    { rows: PLANT, x: 70, y: 15 },
  ] satisfies Prop[],
}

export interface RoomScene {
  /** Ancho en píxeles de arte (alto fijo de 26). */
  width: 40 | 80
  wall: string
  floor: string
  back: Prop[]
  front: Prop[]
  /** Dónde se para la Muse (arriba a la izquierda de su 16×16). */
  muse: { x: number; y: number }
}

export const ROOM_HEIGHT = 26

export const ROOMS: Record<TeamRole, RoomScene> = {
  ale: {
    width: 80,
    wall: '#2b3446',
    floor: '#1f2633',
    back: [
      { rows: BIG_SCREEN, x: 30, y: 1 },
      { rows: PLANT, x: 4, y: 15 },
      { rows: PLANT, x: 71, y: 15 },
    ],
    front: [{ rows: COUNTER, x: 28, y: 20 }],
    muse: { x: 32, y: 7 },
  },
  investigador: {
    width: 40,
    wall: '#3a2f2a',
    floor: '#2a221e',
    back: [
      { rows: BOOKSHELF, x: 1, y: 2 },
      { rows: BOOKSHELF, x: 29, y: 2 },
      { rows: LAMP, x: 27, y: 14 },
    ],
    front: [{ rows: TABLE, x: 13, y: 21 }],
    muse: { x: 12, y: 8 },
  },
  estratega: {
    width: 40,
    wall: '#2d3340',
    floor: '#22262f',
    back: [
      { rows: WHITEBOARD, x: 13, y: 1 },
      { rows: PLANT, x: 2, y: 15 },
    ],
    front: [],
    muse: { x: 22, y: 9 },
  },
  estructurador: {
    width: 40,
    wall: '#26324a',
    floor: '#1d2433',
    back: [{ rows: BOOKSHELF, x: 29, y: 2 }],
    front: [{ rows: BLUEPRINT, x: 13, y: 19 }],
    muse: { x: 12, y: 7 },
  },
  analista: {
    width: 40,
    wall: '#24303a',
    floor: '#1b232b',
    back: [{ rows: PLANT, x: 33, y: 14 }],
    front: [{ rows: DATA_DESK, x: 12, y: 18 }],
    muse: { x: 12, y: 6 },
  },
  optimizador: {
    width: 40,
    wall: '#33302a',
    floor: '#26231e',
    back: [{ rows: TOOLBOARD, x: 14, y: 1 }],
    front: [{ rows: TABLE, x: 13, y: 21 }],
    muse: { x: 12, y: 8 },
  },
  landings: {
    width: 40,
    wall: '#3a2c48',
    floor: '#2a2135',
    back: [
      { rows: EASEL, x: 29, y: 8 },
      { rows: PLANT, x: 2, y: 2 },
    ],
    front: [{ rows: DESK_MONITOR, x: 10, y: 18 }],
    muse: { x: 9, y: 6 },
  },
  bodega: {
    width: 80,
    wall: '#3b3a37',
    floor: '#2b2a28',
    back: [
      { rows: RACK, x: 2, y: 3 },
      { rows: RACK, x: 18, y: 3 },
      { rows: RACK, x: 50, y: 3 },
      { rows: RACK, x: 64, y: 3 },
      { rows: BOXES, x: 4, y: 20 },
      { rows: BOXES, x: 68, y: 20 },
    ],
    front: [],
    muse: { x: 32, y: 9 },
  },
}
