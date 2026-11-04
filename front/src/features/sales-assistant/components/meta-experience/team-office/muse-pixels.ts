import type {
  TeamRole,
  TeamState,
} from '../../../lib/meta-experience/team-model'

/**
 * Muse en pixel art de 16×16. Cada capa es una lista de 16 filas; `.` es
 * transparente y cada letra es un color de `PALETTE`. Se pintan en orden:
 * cuerpo, cara del estado y accesorio del rol.
 */
export type PixelLayer = readonly string[]

export const PALETTE: Record<string, string> = {
  o: '#3a2e29', // contorno
  b: '#f6eedf', // cuerpo
  s: '#dccdb3', // sombra
  e: '#1d1a18', // ojos y boca
  c: '#f2a7a7', // mejillas
  k: '#2d3142', // auricular
  y: '#f4c430', // casco
  g: '#5b8def', // gafas
  n: '#e76f51', // libreta
  w: '#fff7e8', // hojas
  l: '#a8dadc', // vidrio de la lupa
  m: '#8d6748', // mango
  t: '#9aa5b1', // llave
  r: '#8e5cd9', // boina
  p: '#2a9d8f', // gorra
  x: '#c08a4b', // caja
  X: '#8d6748', // cinta de la caja
}

const BODY: PixelLayer = [
  '................',
  '................',
  '.....oooooo.....',
  '....obbbbbbo....',
  '...obbbbbbbbo...',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '..obbbbbbbbbbo..',
  '.obbbbbbbbbbbbo.',
  '.obbbbbbbbbbbbo.',
  'obsbbbbbbbbbbsbo',
  'obsbbbbbbbbbbsbo',
  '.obbbbbbbbbbbbo.',
  '..ossbbbbbbsso..',
  '...oooooooooo...',
]

const blank = (rows: Record<number, string>): PixelLayer =>
  Array.from({ length: 16 }, (_, index) => rows[index] ?? '................')

/** Una cara por estado: se lee aunque no haya color ni animación. */
const FACES: Record<TeamState, PixelLayer> = {
  working: blank({ 8: '.....e....e.....', 9: '....c......c....' }),
  waiting: blank({
    6: '.....e....e.....',
    7: '.....e....e.....',
    9: '....c..ee...c...',
  }),
  blocked: blank({
    5: '....e......e....',
    7: '.....e....e.....',
    9: '....c..ee..c....',
    10: '......e..e......',
  }),
  done: blank({
    6: '.....e....e.....',
    7: '....e.e..e.e....',
    9: '....ce....ec....',
    10: '......eeee......',
  }),
  resting: blank({ 7: '....ee....ee....', 9: '....c......c....' }),
}

const ACCESSORIES: Record<TeamRole, PixelLayer> = {
  ale: blank({
    1: '....kkkkkkkk....',
    2: '...k........k...',
    3: '..k..........k..',
    6: '.kk..........kk.',
    7: '.kk..........kk.',
    8: '.kk..........kk.',
    9: '.............k..',
    10: '...........kk...',
  }),
  investigador: blank({
    6: '...gggg..gggg...',
    7: '..g...gggg...g..',
    8: '...gggg..gggg...',
  }),
  estratega: blank({
    10: '...........nnnn.',
    11: '...........nwwn.',
    12: '...........nwwn.',
    13: '...........nnnn.',
  }),
  estructurador: blank({
    0: '......yyyy......',
    1: '....yyyyyyyy....',
    2: '...yyyyyyyyyy...',
    3: '..yyyyyyyyyyyy..',
  }),
  analista: blank({
    9: '............mmm.',
    10: '...........mllm.',
    11: '...........mllm.',
    12: '............mm..',
    13: '...........m....',
    14: '..........m.....',
  }),
  optimizador: blank({
    9: '............t.t.',
    10: '............ttt.',
    11: '.............t..',
    12: '............t...',
    13: '...........t....',
  }),
  landings: blank({
    0: '........r.......',
    1: '....rrrrrrr.....',
    2: '...rrrrrrrrrr...',
    3: '...rrrrrrrrrrr..',
  }),
  bodega: blank({
    1: '.....pppppp.....',
    2: '....pppppppp....',
    3: '....pppppppppppp',
    11: 'xxxx............',
    12: 'xXXx............',
    13: 'xxxx............',
  }),
}

export function museLayers(role: TeamRole, state: TeamState): PixelLayer[] {
  return [BODY, FACES[state], ACCESSORIES[role]]
}

export interface PixelRun {
  layer: number
  x: number
  y: number
  width: number
  fill: string
}

/** Junta píxeles seguidos del mismo color: menos nodos en el SVG. */
export function toRuns(
  layers: PixelLayer[],
  palette: Record<string, string> = PALETTE,
  offset = { x: 0, y: 0 }
): PixelRun[] {
  const runs: PixelRun[] = []
  layers.forEach((layer, index) =>
    layer.forEach((row, y) => {
      let x = 0
      while (x < row.length) {
        const key = row[x]
        let end = x
        while (end < row.length && row[end] === key) end += 1
        const fill = palette[key]
        if (fill)
          runs.push({
            layer: index,
            x: x + offset.x,
            y: y + offset.y,
            width: end - x,
            fill,
          })
        x = end
      }
    })
  )
  return runs
}
