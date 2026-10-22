-- Fotos: cada empresa lee solo su carpeta (Joel, 22/10/2026).
--
-- auth_read_fotos (creada desde el panel, no estaba en el repo) tenía un segundo camino: dejaba leer
-- un archivo de CUALQUIER carpeta si alguna foto de un conteo de la empresa lo nombraba
-- (conteo_fotos.foto_url like '%/' || name). Como conteo_fotos solo exige que el conteo sea de la
-- empresa y foto_url es texto libre, alguien de otra empresa que conociera la ruta exacta de una foto
-- ajena podía anotarla en su propio conteo y leerla. Revisado el 22/10/2026: las 3.396 fotos del
-- bucket están en la carpeta de su empresa y ninguna foto de conteo apunta a una carpeta ajena, así
-- que ese camino no lo usa nadie. Además costaba: el like con comodín inicial recorría conteo_fotos
-- por cada archivo (leer la lista completa: 276-831 ms -> ~55 ms).
-- Verificado antes de aplicar, en una transacción revertida: operador de Escondida 3.391 fotos,
-- admin de Agunsa 1, operador de la Demo 4, súper admin 3.391 -- iguales antes y después.
-- Las fotos de tickets para el súper admin siguen en super_admin_lee_fotos_tickets.
-- auth_upload_fotos: mismo filtro, con empresa_actual() envuelta en select (una vez por consulta).

set local lock_timeout = '5s';

alter policy auth_read_fotos on storage.objects
  using ((bucket_id = 'fotos-inventario'::text)
         and ((storage.foldername(name))[1] = (( select public.empresa_actual() as empresa_actual))::text));

alter policy auth_upload_fotos on storage.objects
  with check ((bucket_id = 'fotos-inventario'::text)
              and ((storage.foldername(name))[1] = (( select public.empresa_actual() as empresa_actual))::text));
