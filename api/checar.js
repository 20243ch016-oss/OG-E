module.exports = async function handler(req, res) {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '')
    .trim()
    .replace(/\/rest\/v1\/?$/, '')
    .replace(/\/$/, '');
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Faltan variables de entorno en Vercel' });
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY
  };
  if (SERVICE_KEY.startsWith('eyJ')) {
    headers.Authorization = `Bearer ${SERVICE_KEY}`;
  }

  try {
    // Leer estado actual de datos_rh
    const rhRes = await fetch(`${SUPABASE_URL}/rest/v1/datos_rh?select=*&limit=1`, { headers });
    const rows = await rhRes.json();
    if (!rhRes.ok || !Array.isArray(rows) || !rows.length) {
      return res.status(500).json({ error: 'No se pudo leer la tabla datos_rh' });
    }

    const fila = rows[0];
    const estado = fila.data || fila.datos || fila.estado || fila;
    const empleados = Array.isArray(estado.empleados) ? estado.empleados : [];

    // GET: Enviar lista básica de empleados al kiosco para validar IDs
    if (req.method === 'GET') {
      const lista = empleados.map((e) => ({
        id: String(e.id || e.empId || e.codigo || ''),
        nombre: e.nombre || 'Colaborador',
        puesto: e.puesto || '',
        depto: e.depto || e.departamento || '',
        foto: e.foto || ''
      }));
      return res.status(200).json({ ok: true, empleados: lista });
    }

    // POST: Registrar entrada o salida
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { empId, tipo, foto } = body;

      if (!empId || !tipo) {
        return res.status(400).json({ error: 'Ingresa tu ID de empleado' });
      }

      const emp = empleados.find(
        (e) => String(e.id || e.empId || e.codigo || '').toLowerCase() === String(empId).trim().toLowerCase()
      );
      if (!emp) {
        return res.status(404).json({ error: 'ID de empleado no encontrado' });
      }

      const ahora = new Date();
      // Hora local México (UTC-6)
      const mx = new Date(ahora.getTime() - 6 * 60 * 60 * 1000);
      const fecha = mx.toISOString().slice(0, 10);
      const hora = mx.toISOString().slice(11, 16);

      if (!Array.isArray(estado.asistencias)) estado.asistencias = [];

      // Buscar si ya tiene registro hoy
      let reg = estado.asistencias.find(
        (a) => String(a.empId || a.empleadoId) === String(emp.id) && a.fecha === fecha
      );

      if (tipo === 'entrada') {
        if (reg && reg.entrada) {
          return res.status(400).json({ error: `${emp.nombre} ya registró entrada hoy a las ${reg.entrada}` });
        }
        const esRetardo = hora > '09:10'; // Tolerancia 9:10 AM
        const nuevoReg = {
          id: 'asi_' + Date.now(),
          empId: emp.id,
          nombre: emp.nombre,
          fecha,
          entrada: hora,
          salida: '',
          estatus: esRetardo ? 'Retardo' : 'Puntual',
          fotoChecada: foto || '',
          origen: 'Kiosco Checador'
        };
        estado.asistencias.unshift(nuevoReg);
      } else if (tipo === 'salida') {
        if (!reg) {
          return res.status(400).json({ error: `${emp.nombre} no tiene entrada registrada hoy` });
        }
        reg.salida = hora;
        if (foto) reg.fotoSalida = foto;
      }

      // Registrar en bitácora si existe
      if (Array.isArray(estado.auditoria)) {
        estado.auditoria.unshift({
          fecha: `${fecha} ${hora}`,
          usuario: emp.nombre,
          accion: `Checador Kiosco: ${tipo.toUpperCase()} (${hora})`
        });
      }

      // Guardar actualización en Supabase
      const columnaJson = fila.data ? 'data' : fila.datos ? 'datos' : fila.estado ? 'estado' : null;
      const payload = columnaJson ? { [columnaJson]: estado } : estado;
      if (typeof fila.version === 'number') payload.version = fila.version + 1;

      const filtroId = fila.id !== undefined ? `id=eq.${fila.id}` : '';
      const updRes = await fetch(`${SUPABASE_URL}/rest/v1/datos_rh?${filtroId}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(payload)
      });

      if (!updRes.ok) {
        return res.status(500).json({ error: 'Error al guardar la asistencia en Supabase' });
      }

      return res.status(200).json({
        ok: true,
        empleado: emp.nombre,
        puesto: emp.puesto || '',
        hora,
        tipo
      });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (err) {
    return res.status(500).json({ error: 'Error interno: ' + err.message });
  }
};
