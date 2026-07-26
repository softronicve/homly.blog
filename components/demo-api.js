import { HomlyComponent, Homly } from 'homly';

/**
 * Demo en vivo de `store.resource` + `Homly.bindQuery` para el post de v1.9.0.
 *
 * Consulta un JSON estático del propio blog y filtra del lado del cliente, que es lo que
 * una API real haría del lado del servidor. Lo que se muestra de verdad es el ciclo
 * completo: estado de carga, debounce, filtro reflejado en la URL y el aborto de la
 * ejecución anterior.
 */
class DemoApi extends HomlyComponent {
  get basePath() { return import.meta.url; }
  get templateUrl() { return './demo-api.html'; }
  get styleUrl() { return './demo-api.css'; }

  get store() {
    return (this._store ??= (() => {
      const store = Homly.createStore({ q: '', lentitud: true });

      // Antes del resource: así la primera petición ya usa el filtro que venga en la URL.
      Homly.bindQuery(store, ['q'], this.signal);

      this._recurso = store.resource('propiedades', ['q', 'lentitud'], async (q, lentitud, { signal }) => {
        // Retardo simulado y rotulado: sin él la respuesta es instantánea y el estado
        // de carga —que es justo lo que el demo quiere mostrar— no se llega a ver.
        if (lentitud) await new Promise(r => setTimeout(r, 700));

        const res = await fetch('/demo/propiedades.json', { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const todas = await res.json();
        const t = q.trim().toLowerCase();
        return t
          ? todas.filter(p => (p.titulo + ' ' + p.zona).toLowerCase().includes(t))
          : todas;
      }, { debounce: 300 });

      store.computed('cuenta', ['propiedades'], p => String((p || []).length));
      store.computed('vacio', ['propiedades', 'propiedadesLoading'],
        (p, cargando) => !cargando && (p || []).length === 0);

      return store;
    })());
  }

  get actions() {
    return {
      limpiar: () => { this.store.state.q = ''; },
      recargar: () => this._recurso?.refresh(),
    };
  }
}

customElements.define('demo-api', DemoApi);
