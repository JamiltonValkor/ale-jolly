import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

/**
 * MLB-004: skills por tipo de negocio y por función del bundle 1.3.0. La
 * validación con el código de Hermes vive en
 * distribution/saleads-sales-agent/1.3.0/validate.py; esta prueba cubre lo que
 * debe sostenerse en CI sin el checkout de Hermes.
 */
const SKILLS = 'distribution/saleads-sales-agent/1.3.0/skills';
const TYPES = ['physical_product', 'service', 'infoproduct'];
const EXPECTED = {
  'types/physical_product/saleads-type-physical-product': {origin: 'juan'},
  'types/infoproduct/saleads-type-infoproduct': {origin: 'bf-v3-r3'},
  'types/service/saleads-type-service': {origin: 'derivada'},
  'functions/saleads-market-research': {origin: 'juan'},
  'functions/saleads-reading-diagnosis': {origin: 'saleads'},
  'functions/saleads-optimization-scaling': {origin: 'juan'},
} as const;

/** Tools que mueven dinero o cambian el estado de campañas: las skills solo nombran saleads_request_approval. */
const MUTATING_TOOLS = /saleads_(pause_campaign|request_resume_campaign|request_plan_launch|approve_campaign|update_plan|set_campaign_images|update_campaign_copies|quote_special_plan)/;
/** Lo que nunca se inventa (invariante 8). Una frase que lo nombra junto a un verbo de crear debe negarlo. */
const INVENTED = /testimonio|cifra|métrica|resultado|descuento|escasez|cupo|garant[ií]a|autoridad|certificaci[oó]n|iniciales/i;
const CREATE = /\b(inventa|inventes|inventar|fabrica|fabricar|simula|simular|crea(r)? (un|una|unos|unas)? ?(testimonio|cifra|descuento|garant))/i;
const NEGATION = /\b(no|nunca|ni|sin|jamás)\b/i;

const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});
const skillDirs = () => files(SKILLS).filter(path => path.endsWith('/SKILL.md')).map(path => relative(SKILLS, path).replace(/\/SKILL\.md$/, ''));
const read = (dir: string) => readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8');
const frontmatter = (text: string) => text.split('\n---\n')[0] ?? '';
const bytes = (dir: string) => files(join(SKILLS, dir)).reduce((sum, path) => sum + statSync(path).size, 0);

describe('skills por tipo y por función, bundle 1.3.0 (MLB-004)', () => {
  it('están las seis, en su carpeta y con nombres únicos en todo el árbol', () => {
    const dirs = skillDirs().filter(dir => dir.startsWith('types/') || dir.startsWith('functions/'));
    expect(dirs.sort()).toEqual(Object.keys(EXPECTED).sort());
    const names = skillDirs().map(dir => dir.split('/').at(-1));
    expect(new Set(names).size).toBe(names.length);
  });

  it('cada SKILL.md lleva name, descripción ≤ 1024, version 1.3.0, metadata.hermes y metadata.saleads con origen y confianza', () => {
    for (const [dir, {origin}] of Object.entries(EXPECTED)) {
      const fm = frontmatter(read(dir));
      const name = dir.split('/').at(-1);
      expect(fm).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: "[^"\\n]+"\\nversion: 1\\.3\\.0\\nmetadata:\\n  hermes:\\n    category: saleads-[a-z]+\\n    tags: \\[`));
      expect((/description: "([^"\n]+)"/.exec(fm)?.[1] ?? '').length).toBeLessThanOrEqual(1024);
      expect(fm).toContain(`  saleads:\n    origin: ${origin}\n    confidence: `);
      expect(fm).toMatch(/confidence: (low|medium|high)$/m);
    }
  });

  it('las skills de tipo declaran su business_type; servicios es derivada, de confianza baja y dice de dónde sale', () => {
    for (const type of TYPES) {
      const [dir] = Object.keys(EXPECTED).filter(key => key.startsWith(`types/${type}/`));
      expect(frontmatter(read(dir ?? ''))).toContain(`business_type: ${type}`);
    }
    const service = frontmatter(read('types/service/saleads-type-service'));
    expect(service).toContain('confidence: low');
    expect(service).toContain('derived_from: [saleads-type-physical-product, bf-v3-servicios]');
  });

  it('ninguna frase manda inventar testimonios, cifras, descuentos, escasez, garantías o autoridad sin negarlo', () => {
    for (const dir of Object.keys(EXPECTED)) {
      const text = files(join(SKILLS, dir)).map(path => readFileSync(path, 'utf8')).join('\n');
      const sentences = text.split(/(?<=[.!?:])\s+|\n/);
      const offending = sentences.filter(sentence => CREATE.test(sentence) && INVENTED.test(sentence) && !NEGATION.test(sentence));
      expect({dir, offending}).toEqual({dir, offending: []});
    }
  });

  it('ninguna skill nombra tools que muevan dinero; el gasto pasa por saleads_request_approval', () => {
    for (const dir of Object.keys(EXPECTED)) expect(read(dir)).not.toMatch(MUTATING_TOOLS);
    for (const dir of ['types/physical_product/saleads-type-physical-product', 'functions/saleads-optimization-scaling']) {
      expect(read(dir)).toContain('saleads_request_approval');
    }
  });

  it('la investigación no usa bloques visuales ni pide permiso para seguir, y pide permiso antes de gastar créditos', () => {
    const research = files(join(SKILLS, 'functions/saleads-market-research')).map(path => readFileSync(path, 'utf8')).join('\n');
    expect(research).not.toMatch(/show_widget|read_me|¿sigo|¿Sigo/);
    expect(research).toMatch(/no gastes sin permiso/i);
  });

  it('cada skill de especialista termina con la orden de guardar en memoria (compuerta MLB-001)', () => {
    for (const dir of Object.keys(EXPECTED)) expect(read(dir)).toMatch(/## Al terminar una tarjeta[^\n]*\n[\s\S]*Guarda en tu memoria/);
  });

  it('topes de tamaño: SKILL.md ≤ 20 KB, con references ≤ 40 KB, y lo de un tipo más las funciones ≤ 100 KB', () => {
    for (const dir of Object.keys(EXPECTED)) {
      expect(statSync(join(SKILLS, dir, 'SKILL.md')).size).toBeLessThanOrEqual(20 * 1024);
      expect(bytes(dir)).toBeLessThanOrEqual(40 * 1024);
    }
    for (const type of TYPES) expect(bytes(`types/${type}`) + bytes('functions')).toBeLessThanOrEqual(100 * 1024);
  });
});
