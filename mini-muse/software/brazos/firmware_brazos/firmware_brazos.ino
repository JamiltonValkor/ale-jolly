// Brazos de Ale (Mini-Muse) — firmware v2 para Arduino UNO, 2 SG90. Prototipo (la decisión de hardware final es después).
//
// Conexión: brazo DERECHO señal → A0, brazo IZQUIERDO señal → A1 (rojo 5V, café GND).
// Al encender los servos quedan SUELTOS (sin pulso), como la cabeza HESed.
//
// Unidad física: microsegundos. El host (Mac) envía los límites reales de cada brazo (brazos.yaml) al conectar:
//   L <d|i> <min_us> <reposo_us> <max_us>     límites calibrados (el Arduino no guarda nada: el host es la verdad)
// Unidad de gestos: % de elevación. 0 = reposo, 100 = máximo (brazo arriba), −100 = mínimo (tope opuesto).
// El pulso SIEMPRE queda dentro de [min_us, max_us] (o 100–2900 al alinear con U: rango de la librería Servo).
//
// Protocolo (115200, una orden por línea; responde OK…/ERR…):
//   M <der%> <izq%> <ms>   mover suave a esas elevaciones (use 999 para no tocar un brazo). ERR si faltan límites.
//   U <d|i> <us>           pulso crudo para ALINEAR (100–2900 µs), inmediato
//   X                      soltar los dos servos (sin pulso)
//   E                      estado: "E <der_us> <izq_us> <der_%> <izq_%> <energizado>"
//   V <0|1>                eco cada 50 ms: "A <der_us> <izq_us>"
//   G prueba               cada brazo sube y baja (requiere límites)

#include <Servo.h>

const int NO_TOCAR = 999;

struct Brazo {
  Servo servo;
  byte pin;
  bool limites;               // ¿llegaron los límites del host?
  int minUs, reposoUs, maxUs;
  float actualUs;             // pulso actual
  float desdeUs, haciaUs;
  unsigned long t0, dur;
  bool unido;                 // servo.attach hecho
  bool crudo;                 // alineando con U: rango físico 500–2500, SIN recortar a los límites
};

Brazo der = {Servo(), A0, false, 1000, 1500, 2000, 1500, 1500, 1500, 0, 1, false, false};
Brazo izq = {Servo(), A1, false, 1000, 1500, 2000, 1500, 1500, 1500, 0, 1, false, false};

bool eco = false;
unsigned long ultimoEco = 0;
String linea;

// prueba: lista de (ms, der%, izq%)
const int PRUEBA[][3] = {{1200, 100, NO_TOCAR}, {1200, 0, NO_TOCAR}, {1200, NO_TOCAR, 100}, {1200, NO_TOCAR, 0}};
int pasoPrueba = -1;

Brazo& elegir(char c) { return (c == 'i' || c == 'I') ? izq : der; }

void unir(Brazo& b) {
  if (b.unido) return;
  b.servo.attach(b.pin, 100, 2900);            // máximo que permite la librería Servo del UNO
  b.unido = true;
}

void soltar(Brazo& b) {
  if (b.unido) b.servo.detach();
  b.unido = false;
  b.desdeUs = b.haciaUs = b.actualUs;
}

int limitar(Brazo& b, float us) {
  if (!b.limites || b.crudo) return constrain((int)us, 100, 2900);
  return constrain((int)us, min(b.minUs, b.maxUs), max(b.minUs, b.maxUs));
}

// % de elevación → µs: 0..100 entre reposo y máximo; 0..−100 entre reposo y mínimo
float usDe(Brazo& b, float pct) {
  pct = constrain(pct, -100, 100);
  if (pct >= 0) return b.reposoUs + (b.maxUs - b.reposoUs) * pct / 100.0;
  return b.reposoUs + (b.minUs - b.reposoUs) * (-pct) / 100.0;
}

float pctDe(Brazo& b, float us) {
  if (!b.limites) return 0;
  float arriba = b.maxUs - b.reposoUs, abajo = b.minUs - b.reposoUs;
  float d = us - b.reposoUs;
  if (arriba != 0 && d * arriba >= 0) return 100.0 * d / arriba;
  if (abajo != 0) return -100.0 * d / abajo;
  return 0;
}

void ir(Brazo& b, float us, unsigned long ms) {
  unir(b);
  b.crudo = false;                                  // gestos y % siempre dentro de los límites calibrados
  b.desdeUs = b.actualUs;
  b.haciaUs = limitar(b, us);
  b.t0 = millis();
  b.dur = max(ms, 1UL);
}

void avanzar(Brazo& b, unsigned long ahora) {
  if (!b.unido) return;
  float f = (float)(ahora - b.t0) / b.dur;
  if (f > 1) f = 1;
  float s = 0.5 - 0.5 * cos(PI * f);              // arranca y frena suave
  b.actualUs = b.desdeUs + (b.haciaUs - b.desdeUs) * s;
  b.servo.writeMicroseconds(limitar(b, b.actualUs));
}

bool quieto(Brazo& b) { return millis() - b.t0 >= b.dur; }

void moverPct(int d, int i, unsigned long ms) {
  if (d != NO_TOCAR) ir(der, usDe(der, d), ms);
  if (i != NO_TOCAR) ir(izq, usDe(izq, i), ms);
}

void orden(String s) {
  s.trim();
  if (!s.length()) return;
  char c = toupper(s[0]);
  String r = s.substring(1); r.trim();
  if (c == 'L') {
    char cual; int mn, rp, mx;
    if (sscanf(r.c_str(), "%c %d %d %d", &cual, &mn, &rp, &mx) != 4) { Serial.println(F("ERR L <d|i> <min> <reposo> <max>")); return; }
    if (!((mn <= rp && rp <= mx) || (mx <= rp && rp <= mn)) || mn < 100 || mx > 2900 || mx < 100 || mn > 2900) {
      Serial.println(F("ERR L reposo debe quedar entre min y max (100-2900)")); return;
    }
    Brazo& b = elegir(cual);
    b.minUs = mn; b.reposoUs = rp; b.maxUs = mx; b.limites = true;
    if (!b.unido) b.actualUs = b.desdeUs = b.haciaUs = rp;
    Serial.println(F("OK L"));
  } else if (c == 'M') {
    int d = NO_TOCAR, i = NO_TOCAR; long ms = 500;
    if (sscanf(r.c_str(), "%d %d %ld", &d, &i, &ms) < 2) { Serial.println(F("ERR M <der%> <izq%> <ms>")); return; }
    if ((d != NO_TOCAR && !der.limites) || (i != NO_TOCAR && !izq.limites)) { Serial.println(F("ERR M faltan limites (L)")); return; }
    pasoPrueba = -1;
    moverPct(d, i, ms);
    Serial.println(F("OK M"));
  } else if (c == 'U') {
    char cual; int us;
    if (sscanf(r.c_str(), "%c %d", &cual, &us) != 2) { Serial.println(F("ERR U <d|i> <us>")); return; }
    Brazo& b = elegir(cual);
    pasoPrueba = -1;
    unir(b);
    b.crudo = true;                                  // alinear: el usuario está BUSCANDO los límites
    int v = constrain(us, 100, 2900);                // para alinear: rango físico, no los límites
    b.actualUs = b.desdeUs = b.haciaUs = v; b.t0 = millis(); b.dur = 1;
    b.servo.writeMicroseconds(v);
    Serial.print(F("OK U ")); Serial.println(v);
  } else if (c == 'X') {
    pasoPrueba = -1; soltar(der); soltar(izq);
    Serial.println(F("OK X sueltos"));
  } else if (c == 'E') {
    Serial.print(F("E ")); Serial.print((int)der.actualUs); Serial.print(' '); Serial.print((int)izq.actualUs); Serial.print(' ');
    Serial.print((int)round(pctDe(der, der.actualUs))); Serial.print(' '); Serial.print((int)round(pctDe(izq, izq.actualUs)));
    Serial.print(' '); Serial.println((der.unido || izq.unido) ? 1 : 0);
  } else if (c == 'V') {
    eco = r.toInt() == 1; Serial.println(F("OK V"));
  } else if (c == 'G') {
    if (!der.limites || !izq.limites) { Serial.println(F("ERR G faltan limites (L)")); return; }
    pasoPrueba = 0; moverPct(PRUEBA[0][1], PRUEBA[0][2], PRUEBA[0][0]);
    Serial.println(F("OK G prueba"));
  } else {
    Serial.println(F("ERR orden desconocida (L M U X E V G)"));
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println(F("LISTO brazos-ale v2.1 (A0 der, A1 izq, sueltos, us+limites)"));
}

void loop() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') { orden(linea); linea = ""; }
    else if (linea.length() < 64) linea += ch;
  }
  unsigned long ahora = millis();
  avanzar(der, ahora); avanzar(izq, ahora);
  if (pasoPrueba >= 0 && quieto(der) && quieto(izq)) {
    if (++pasoPrueba >= 4) { pasoPrueba = -1; Serial.println(F("FIN")); }
    else moverPct(PRUEBA[pasoPrueba][1], PRUEBA[pasoPrueba][2], PRUEBA[pasoPrueba][0]);
  }
  if (eco && ahora - ultimoEco >= 50) {
    ultimoEco = ahora;
    Serial.print(F("A ")); Serial.print(der.unido ? (int)der.actualUs : 0); Serial.print(' ');
    Serial.println(izq.unido ? (int)izq.actualUs : 0);
  }
  delay(4);
}
