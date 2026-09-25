require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { LoginTicket, Wsfev1 } = require('afip-apis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const isProd = process.env.ARCA_PRODUCCION === 'true';
const CUIT = Number(process.env.ARCA_CUIT || 30718195477);
const PTO_VENTA = Number(process.env.ARCA_PTO_VENTA || 3);

// Manejo seguro de certificados para Local o Cloud (Railway)
let certPath = process.env.ARCA_CERT_PATH ? path.resolve(__dirname, process.env.ARCA_CERT_PATH) : null;
let keyPath = process.env.ARCA_KEY_PATH ? path.resolve(__dirname, process.env.ARCA_KEY_PATH) : null;

if (process.env.ARCA_CERT_CONTENT && process.env.ARCA_KEY_CONTENT) {
  const tmpCert = path.resolve('/tmp', 'certificado.crt');
  const tmpKey = path.resolve('/tmp', 'privado.key');
  fs.writeFileSync(tmpCert, process.env.ARCA_CERT_CONTENT.replace(/\\n/g, '\n'));
  fs.writeFileSync(tmpKey, process.env.ARCA_KEY_CONTENT.replace(/\\n/g, '\n'));
  certPath = tmpCert;
  keyPath = tmpKey;
}

// Endpoints oficiales ARCA
const WSAA_URL = isProd
  ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
  : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';

const WSFE_URL = isProd
  ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
  : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';

const loginTicketManager = new LoginTicket();
const wsfe = new Wsfev1(WSFE_URL);

let authTicketCache = null;

async function getAuthPayload() {
  const now = new Date();
  if (authTicketCache && authTicketCache.expiration > now) {
    return {
      Token: authTicketCache.token,
      Sign: authTicketCache.sign,
      Cuit: CUIT
    };
  }

  if (!certPath || !keyPath) {
    throw new Error('Certificados de ARCA no configurados en las rutas o variables de entorno');
  }

  // Obtenemos el ticket de acceso del WSAA
  const ticket = await loginTicketManager.wsaaLogin('wsfe', WSAA_URL, certPath, keyPath, 720);

  console.log('[DEBUG TICKET COMPLETO]:', JSON.stringify(ticket, null, 2));

  const tokenReal = ticket?.Token || ticket?.token || ticket?.credentials?.token;
  const signReal = ticket?.Sign || ticket?.sign || ticket?.credentials?.sign;
  const expirationReal = ticket?.expirationTime || ticket?.ExpirationTime || ticket?.header?.expirationTime;

  console.log('[DEBUG AUTH REAL] Token obtenido:', tokenReal ? tokenReal.substring(0, 30) + '...' : 'SIGUE UNDEFINED');
  console.log('[DEBUG AUTH REAL] Sign obtenido:', signReal ? signReal.substring(0, 30) + '...' : 'SIGUE UNDEFINED');

  authTicketCache = {
    token: tokenReal,
    sign: signReal,
    expiration: new Date(expirationReal || Date.now() + 10 * 3600 * 1000)
  };

  return {
    Token: tokenReal,
    Sign: signReal,
    Cuit: CUIT
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/status', async (req, res) => {
  try {
    const dummyResp = await wsfe.FEDummy();
    const Auth = await getAuthPayload();

    const respLast = await wsfe.FECompUltimoAutorizado({
      Auth,
      PtoVta: PTO_VENTA,
      CbteTipo: 1
    });

    const ultimoComprobante = respLast?.FECompUltimoAutorizadoResult?.CbteNro ?? 0;

    res.json({
      success: true,
      servidoresArca: dummyResp?.FEDummyResult || dummyResp,
      puntoVenta: PTO_VENTA,
      ultimoComprobanteFacturaA: ultimoComprobante
    });
  } catch (error) {
    console.error('Error al conectar con ARCA:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al conectar con ARCA'
    });
  }
});

app.post('/api/facturar', async (req, res) => {
  try {
    const { 
      puntoVenta = PTO_VENTA, 
      tipoComprobante = 1,
      concepto = 2,
      importeNeto, 
      importeIVA, 
      docTipo = 80, 
      docNro 
    } = req.body;

    const neto = Number(importeNeto);
    const iva = Number(importeIVA);
    const total = Math.round((neto + iva) * 100) / 100;

    const Auth = await getAuthPayload();

    // 1. Obtener último comprobante
    const respLast = await wsfe.FECompUltimoAutorizado({
      Auth,
      PtoVta: Number(puntoVenta),
      CbteTipo: Number(tipoComprobante)
    });
    const lastVoucher = Number(respLast?.FECompUltimoAutorizadoResult?.CbteNro ?? 0);
    const nextVoucherNumber = lastVoucher + 1;

    console.log(`\n========================================`);
    console.log(`[ARCA SOLICITUD] Pto Vta: ${puntoVenta} | Cbte N°: ${nextVoucherNumber} | Total: $${total}`);

    const hoyStr = new Date(Date.now() - (new Date()).getTimezoneOffset() * 60000)
      .toISOString()
      .split('T')[0]
      .replace(/-/g, '');

    // Estructura XML que recibe ARCA
    const requestData = {
      Auth: {
        Token: Auth.Token,
        Sign: Auth.Sign,
        Cuit: CUIT
      },
      FeCAEReq: {
        FeCabReq: {
          CantReg: 1,
          PtoVta: Number(puntoVenta),
          CbteTipo: Number(tipoComprobante)
        },
        FeDetReq: {
          FECAEDetRequest: [
            {
              Concepto: Number(concepto),
              DocTipo: Number(docTipo),
              DocNro: Number(docNro),
              CbteDesde: Number(nextVoucherNumber),
              CbteHasta: Number(nextVoucherNumber),
              CbteFch: hoyStr,
              ImpTotal: total,
              ImpTotConc: 0,
              ImpNeto: neto,
              ImpOpEx: 0,
              ImpIVA: iva,
              ImpTrib: 0,
              MonId: 'PES',
              MonCotiz: 1,
              FchServDesde: hoyStr,
              FchServHasta: hoyStr,
              FchVtoPago: hoyStr,
              CondicionIVAReceptorId: 1,
              Iva: {
                AlicIva: [
                  {
                    Id: 5,
                    BaseImp: neto,
                    Importe: iva
                  }
                ]
              }
            }
          ]
        }
      }
    };

    const respCAE = await wsfe.FECAESolicitar(requestData);

    console.log('[ARCA RESPUESTA CRUDA]:', JSON.stringify(respCAE, null, 2));

    const resResult = respCAE?.FECAESolicitarResult || respCAE;
    const detRespRaw = resResult?.FeDetResp?.FECAEDetResponse;
    const detResp = Array.isArray(detRespRaw) ? detRespRaw[0] : detRespRaw;

    if (!detResp || detResp.Resultado === 'R') {
      const obs = detResp?.Observaciones || resResult?.Errors;
      console.error('[ARCA RECHAZADO]:', obs);
      return res.status(400).json({
        success: false,
        motivo: 'Comprobante rechazado por ARCA',
        observaciones: obs
      });
    }

    console.log(`[ARCA APROBADO] CAE: ${detResp.CAE} | Vto: ${detResp.CAEFchVto}`);
    console.log(`========================================\n`);

    res.json({
      success: true,
      nroComprobante: nextVoucherNumber,
      cae: detResp.CAE,
      caeVto: detResp.CAEFchVto
    });

  } catch (error) {
    console.error('Error al emitir factura:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al comunicarse con ARCA'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de facturación corriendo en el puerto ${PORT}`);
});