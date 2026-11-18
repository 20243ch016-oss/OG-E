module.exports = async function handler(req, res) {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '')
    .trim()
    .replace(/\/rest\/v1\/?$/, '')
    .replace(/\/$/, '');
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Faltan variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en Vercel' });
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY
  };
  if (SERVICE_KEY.startsWith('eyJ')) {
    headers.Authorization = `Bearer ${SERVICE_KEY}`;
  }

  function horaConTolerancia(horaBase) {
    const [h, m] = (horaBase || '09:00').split(':').map(Number);
    const total = (h || 9) * 60 + (m || 0) + 10;
    const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  try {
    const rhRes = await fetch(`${SUPABASE_URL}/rest/v1/datos_rh?select=*&limit=1`, { headers });
    const rows = await rhRes.json();
    if (!rhRes.ok || !Array.isArray(rows) || !rows.length) {
      return res.status(500).json({ error: 'No se pudo leer la tabla datos_rh en Supabase' });
    }

    const fila = rows[0];
    const estado = fila.data || fila.datos || fila.estado || fila;
    const empleados = Array.isArray(estado.empleados)
      ? estado.empleados
      : Array.isArray(estado.emps)
        ? estado.emps
        : [];

    // GET: Enviar empleados con el ID asignado por RH
    if (req.method === 'GET') {
      const lista = empleados.map((e) => ({
        id: String(e.codigo || e.id || ''),
        nombre: e.nombre || 'Colaborador',
        puesto: e.puesto || '',
        horaEntrada: e.horaEntrada || e.entrada || '09:00'
      }));
      return res.status(200).json({ ok: true, empleados: lista });
    }

    // POST: Registrar entrada o salida desde el Kiosco
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { empId, tipo, foto } = body;

      if (!empId || !tipo) {
        return res.status(400).json({ error: 'Ingresa tu ID de empleado asignado por RH' });
      }

      const buscado = String(empId).trim().toLowerCase();
      const emp = empleados.find(
        (e) =>
          String(e.codigo || '').trim().toLowerCase() === buscado ||
          String(e.id || '').trim().toLowerCase() === buscado
      );

      if (!emp) {
        return res.status(404).json({ error: `El ID "${empId}" no existe. Verifica con Recursos Humanos.` });
      }

      const ahora = new Date();
      const fecha = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Mexico_City',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(ahora);

      const hora = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Mexico_City',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(ahora);

      const listaAsis = Array.isArray(estado.asistencias)
        ? estado.asistencias
        : Array.isArray(estado.asis)
          ? estado.asis
          : (estado.asistencias = []);

      const idInterno = emp.id || emp.codigo;
      let reg = listaAsis.find(
        (a) =>
          (String(a.empId || a.empleadoId || a.eid) === String(idInterno) ||
            String(a.codigoEmp || '') === String(emp.codigo || '')) &&
          (a.fecha || a.f) === fecha
      );

      const horaProgramada = emp.horaEntrada || emp.entrada || '09:00';
      const limiteTolerancia = horaConTolerancia(horaProgramada);
      const estatusCalculado = hora <= limiteTolerancia ? 'A tiempo' : 'Retardo';

      if (tipo === 'entrada') {
        if (reg && (reg.entrada || reg.i || reg.in)) {
          return res.status(400).json({
            error: `${emp.nombre} ya registró su entrada hoy a las ${reg.entrada || reg.i || reg.in}`
          });
        }

        const nuevoReg = {
          id: 'asi_' + Date.now(),
          empId: idInterno,
          eid: idInterno,
          codigoEmp: emp.codigo || idInterno,
          nombre: emp.nombre,
          fecha,
          f: fecha,
          entrada: hora,
          i: hora,
          salida: '',
          o: '',
          estatus: estatusCalculado,
          fotoChecada: foto || '',
          origen: 'Terminal Checador'
        };
        listaAsis.unshift(nuevoReg);
      } else if (tipo === 'salida') {
        if (!reg) {
          return res.status(400).json({ error: `${emp.nombre} aún no tiene entrada registrada hoy` });
        }
        if (reg.salida || reg.o) {
          return res.status(400).json({ error: `${emp.nombre} ya registró salida hoy a las ${reg.salida || reg.o}` });
        }
        reg.salida = hora;
        reg.o = hora;
        if (foto) reg.fotoSalida = foto;
      }

      if (Array.isArray(estado.auditoria)) {
        estado.auditoria.unshift({
          fecha: `${fecha} ${hora}`,
          usuario: `${emp.nombre} (ID: ${emp.codigo || idInterno})`,
          accion: `Checador: ${tipo.toUpperCase()} a las ${hora} (${estatusCalculado})`
        });
      }

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
        return res.status(500).json({ error: 'Error al guardar asistencia en Supabase' });
      }

      return res.status(200).json({
        ok: true,
        empleado: emp.nombre,
        codigo: emp.codigo || idInterno,
        hora,
        tipo,
        estatus: estatusCalculado
      });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (err) {
    return res.status(500).json({ error: 'Error interno: ' + err.message });
  }
};
