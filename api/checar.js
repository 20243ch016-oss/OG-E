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

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function mins(t) {
    const p = (t || '09:00').split(':');
    return (+p[0] || 0) * 60 + (+p[1] || 0);
  }

  try {
    const rhRes = await fetch(`${SUPABASE_URL}/rest/v1/datos_rh?id=eq.1&select=data,version`, { headers });
    const rows = await rhRes.json();
    if (!rhRes.ok || !Array.isArray(rows) || !rows.length) {
      return res.status(500).json({ error: 'No se encontró el registro principal en datos_rh' });
    }

    const fila = rows[0];
    const S = fila.data || { emps: [], asis: [], vac: [], inc: [], nom: [], aud: [], retro: [] };
    S.emps = Array.isArray(S.emps) ? S.emps : [];
    S.asis = Array.isArray(S.asis) ? S.asis : [];
    S.aud = Array.isArray(S.aud) ? S.aud : [];

    // GET: Listar empleados activos con su ID asignado por RH
    if (req.method === 'GET') {
      const activos = S.emps
        .filter((e) => e.estatus !== 'Baja')
        .map((e) => ({
          id: String(e.codigo || e.id),
          nombre: e.nombre || 'Colaborador',
          puesto: e.puesto || ''
        }));
      return res.status(200).json({ ok: true, empleados: activos });
    }

    // POST: Registrar entrada o salida
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { empId, tipo, foto } = body;

      if (!empId || !tipo) {
        return res.status(400).json({ error: 'Ingresa el ID de colaborador asignado por RH' });
      }

      const buscado = String(empId).trim().toLowerCase();
      const emp = S.emps.find(
        (e) =>
          e.estatus !== 'Baja' &&
          (String(e.codigo || '').trim().toLowerCase() === buscado ||
            String(e.id || '').trim().toLowerCase() === buscado)
      );

      if (!emp) {
        return res.status(404).json({ error: `El ID "${empId}" no existe o está dado de baja.` });
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

      let reg = S.asis.find((a) => String(a.emp) === String(emp.id) && a.fecha === fecha);
      const estatusCalc = mins(hora) > mins(emp.hEnt || '09:00') + 10 ? 'Retardo' : 'A tiempo';

      if (tipo === 'entrada') {
        if (reg && reg.ent) {
          return res.status(400).json({ error: `${emp.nombre} ya registró entrada hoy a las ${reg.ent}` });
        }
        if (reg) {
          reg.ent = hora;
          if (foto) reg.fotoEnt = foto;
          reg.origen = 'Terminal Checador';
        } else {
          S.asis.push({
            id: uid(),
            emp: emp.id,
            fecha,
            ent: hora,
            sal: '',
            fotoEnt: foto || '',
            origen: 'Terminal Checador'
          });
        }
      } else if (tipo === 'salida') {
        if (!reg || !reg.ent) {
          return res.status(400).json({ error: `${emp.nombre} aún no tiene entrada registrada hoy` });
        }
        if (reg.sal) {
          return res.status(400).json({ error: `${emp.nombre} ya registró salida hoy a las ${reg.sal}` });
        }
        reg.sal = hora;
        if (foto) reg.fotoSal = foto;
      }

      S.aud.unshift({
        id: uid(),
        fecha: new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
        usuario: `${emp.nombre} (ID: ${emp.codigo || emp.id})`,
        accion: 'Terminal Checador',
        detalle: `${tipo === 'entrada' ? 'Entrada' : 'Salida'} registrada a las ${hora} (${estatusCalc})`
      });

      const updRes = await fetch(`${SUPABASE_URL}/rest/v1/datos_rh?id=eq.1`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          data: S,
          version: (fila.version || 0) + 1,
          updated_at: new Date().toISOString()
        })
      });

      if (!updRes.ok) {
        return res.status(500).json({ error: 'No se pudo guardar en Supabase' });
      }

      return res.status(200).json({
        ok: true,
        empleado: emp.nombre,
        codigo: emp.codigo || emp.id,
        hora,
        tipo,
        estatus: estatusCalc
      });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (err) {
    return res.status(500).json({ error: 'Error interno: ' + err.message });
  }
};
