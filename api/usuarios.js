module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '')
    .replace(/\/rest\/v1\/?$/, '')
    .replace(/\/$/, '');
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Faltan variables de entorno en Vercel' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: 'Sesión no válida' });
  }

  const adminHeaders = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY
  };
  if (SERVICE_KEY.startsWith('eyJ')) {
    adminHeaders.Authorization = `Bearer ${SERVICE_KEY}`;
  }

  try {
    // 1. Verificar que quien llama sea un usuario autenticado con rol RH
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Token inválido' });
    const caller = await userRes.json();

    const perfRes = await fetch(
      `${SUPABASE_URL}/rest/v1/perfiles?user_id=eq.${caller.id}&select=rol`,
      { headers: adminHeaders }
    );
    const perfiles = await perfRes.json();
    if (!perfiles.length || perfiles[0].rol !== 'rh') {
      return res.status(403).json({ error: 'Solo Recursos Humanos puede gestionar accesos' });
    }

    const { accion, email, password, empId } = req.body || {};

    // 2. Crear o actualizar acceso de empleado
    if (accion === 'guardar-acceso') {
      if (!email || !password || !empId) {
        return res.status(400).json({ error: 'Datos incompletos' });
      }

      const existRes = await fetch(
        `${SUPABASE_URL}/rest/v1/perfiles?emp_id=eq.${encodeURIComponent(empId)}&select=user_id`,
        { headers: adminHeaders }
      );
      const existentes = await existRes.json();

      if (existentes.length) {
        const uid = existentes[0].user_id;
        const updAuth = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
          method: 'PUT',
          headers: adminHeaders,
          body: JSON.stringify({ email, password, email_confirm: true })
        });
        if (!updAuth.ok) {
          const err = await updAuth.json();
          return res.status(400).json({ error: err.msg || err.message || 'Error al actualizar acceso' });
        }

        await fetch(`${SUPABASE_URL}/rest/v1/perfiles?user_id=eq.${uid}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ email })
        });

        return res.status(200).json({ ok: true });
      }

      const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ email, password, email_confirm: true })
      });
      const created = await createRes.json();
      if (!createRes.ok) {
        return res.status(400).json({ error: created.msg || created.message || 'No se pudo crear el usuario' });
      }

      await fetch(`${SUPABASE_URL}/rest/v1/perfiles`, {
        method: 'POST',
        headers: { ...adminHeaders, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ user_id: created.id, rol: 'emp', emp_id: empId, email })
      });

      return res.status(200).json({ ok: true });
    }

    // 3. Eliminar acceso de empleado
    if (accion === 'eliminar') {
      const existRes = await fetch(
        `${SUPABASE_URL}/rest/v1/perfiles?emp_id=eq.${encodeURIComponent(empId)}&select=user_id`,
        { headers: adminHeaders }
      );
      const existentes = await existRes.json();

      if (existentes.length) {
        const uid = existentes[0].user_id;
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
          method: 'DELETE',
          headers: adminHeaders
        });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};
