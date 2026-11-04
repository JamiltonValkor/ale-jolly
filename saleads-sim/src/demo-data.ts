import {DEMO_BUSINESS_ID} from './config';

/**
 * Negocio de demo: «Masquebella (demo)», tienda capilar en Colombia (COP).
 * Los nombres de las ofertas casan con los patrones de las semillas de Stock
 * de ale-runtime (`robot/banco/semillas/masquebella-v1.yaml`,
 * `ofertas_por_nombre`): así el inventario simulado y el catálogo coinciden.
 * Todo está marcado como simulado.
 */

export interface DemoOffering {
  id: string;
  type: 'product' | 'service';
  name: string;
  description: string;
  price: number;
  currency: string;
  url: string | null;
}

export const DEMO_OFFERINGS: DemoOffering[] = [
  {id: '0b1c6a3e-8f52-4c51-9a3d-1f0e5b7c2a01', type: 'product', name: 'Bio Mascarilla Capilar 500 g',
    description: 'Mascarilla reparadora para cabello seco o maltratado, frasco de tapa verde de 500 g. (simulado)', price: 45000, currency: 'COP', url: null},
  {id: '0b1c6a3e-8f52-4c51-9a3d-1f0e5b7c2a02', type: 'product', name: 'Tónico Capilar – La Receta CBD',
    description: 'Tónico de 120 ml para estimular el crecimiento y fortalecer desde la raíz. (simulado)', price: 40000, currency: 'COP', url: null},
  {id: '0b1c6a3e-8f52-4c51-9a3d-1f0e5b7c2a03', type: 'product', name: 'Ampolleta Sérum Capilar 30 ml',
    description: 'Sérum concentrado de brillo y sellado de puntas, 30 ml. (simulado)', price: 14000, currency: 'COP', url: null},
  {id: '0b1c6a3e-8f52-4c51-9a3d-1f0e5b7c2a04', type: 'product', name: 'Kit Emergencia y Reparación',
    description: 'Kit con mascarilla, tónico y ampolleta para recuperar el cabello en 30 días. (simulado)', price: 89000, currency: 'COP', url: null},
  {id: '0b1c6a3e-8f52-4c51-9a3d-1f0e5b7c2a05', type: 'product', name: 'Shampoo Capilar 400 ml',
    description: 'Shampoo sin sal en versiones Reparador e Hidratante, 400 ml. (simulado)', price: 32000, currency: 'COP', url: null},
  {id: '0b1c6a3e-8f52-4c51-9a3d-1f0e5b7c2a06', type: 'product', name: 'Aceite Capilar 60 ml',
    description: 'Aceite nutritivo de argán y ricino para puntas abiertas, 60 ml. (simulado)', price: 38000, currency: 'COP', url: null},
];

export const DEMO_BUSINESS = {
  id: DEMO_BUSINESS_ID,
  name: 'Masquebella (demo)',
  offering_type: 'products',
  website_url: null as string | null,
  country: 'CO',
  currency: 'COP',
  whatsapp_number: '+573000000000',
  profile: {
    simulated: true,
    industry: 'Belleza y cuidado capilar',
    description: 'Tienda de productos capilares para mujeres que quieren recuperar su cabello en casa. Vende por WhatsApp e Instagram con envíos a toda Colombia. (simulado)',
    location: 'Cali, Colombia',
    sales_channels: ['whatsapp', 'instagram'],
    ideal_customer: 'Mujeres de 25 a 45 años con cabello seco, quebradizo o con caída, que ya probaron productos de supermercado.',
    differentiators: ['Fórmulas con ingredientes naturales', 'Asesoría por WhatsApp', 'Kits por tipo de daño'],
    brand_colors: ['#1F6F50', '#F2C14E'],
  },
};
