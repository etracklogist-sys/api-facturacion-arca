const express = require('express');
const cors = require('cors');
const Afip = require('@afipsdk/afip.js');

const app = express();
app.use(cors());
app.use(express.json());

// Puerto que asigna Railway dinámicamente o 3000 en local
const PORT = process.env.PORT || 3000;

// Instancia de AFIP en modo TESTING (Homologación)
// Para pruebas no requiere certificados propios, usa los de test
const afip = new Afip({
  CUIT: 20409378472, // CUIT genérico de homologación
  production: false
});

// Endpoint de prueba de salud
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Endpoint para emitir factura
app.post('/api/facturar', async (req, res) => {
  try {
    const { 
      puntoVenta = 1, 
      tipoComprobante = 6, // 6 = Factura B, 11 = Factura C
      concepto = 1,        // 1 = Productos, 2 = Servicios
      importeNeto = 1000, 
      importeIVA = 210, 
      docTipo = 99,        // 99 = Consumidor Final
      docNro = 0 
    } = req.body;

    const importeTotal = Number(importeNeto) + Number(importeIVA);

    // 1. Consultar el último comprobante autorizado
    const lastVoucher = await afip.ElectronicBilling.getLastVoucher(puntoVenta, tipoComprobante);
    const nextVoucherNumber = lastVoucher + 1;

    // 2. Fecha actual en formato YYYYMMDD
    const date = new Date(Date.now() - (new Date()).getTimezoneOffset() * 60000)
      .toISOString()
      .split('T')[0]
      .replace(/-/g, '');

    // 3. Payload para solicitar CAE
    const data = {
      CantReg: 1,
      PtoVta: puntoVenta,
      CbteTipo: tipoComprobante,
      Concepto: concepto,
      DocTipo: docTipo,
      DocNro: docNro,
      CbteDesde: nextVoucherNumber,
      CbteHasta: nextVoucherNumber,
      CbteFch: parseInt(date),
      ImpTotal: importeTotal,
      ImpTotConc: 0,
      ImpNeto: importeNeto,
      ImpOpEx: 0,
      ImpIVA: importeIVA,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1,
      Iva: [
        {
          Id: 5, // 5 = 21%
          BaseImp: importeNeto,
          Importe: importeIVA
        }
      ]
    };

    // 4. Solicitar CAE a los servidores de ARCA
    const response = await afip.ElectronicBilling.createVoucher(data);

    res.json({
      success: true,
      nroComprobante: nextVoucherNumber,
      cae: response.CAE,
      caeVto: response.CAEFchVto
    });

  } catch (error) {
    console.error('Error al emitir:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al comunicarse con ARCA'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de facturación corriendo en el puerto ${PORT}`);
});