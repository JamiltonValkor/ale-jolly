/** Aviso del modo local cuando `saleads-sim` no entrega la sesión demo. */
export function LocalSessionNotice() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black p-6 text-white">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">Esperando la sesión demo</h1>
        <p className="text-sm text-white/70">
          El front no pudo obtener el token del usuario demo desde saleads-sim
          (simulado). Revisa que el servicio esté arriba con{' '}
          <code>./demo.sh up</code> y recarga la página.
        </p>
      </div>
    </main>
  )
}
