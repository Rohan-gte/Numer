const targetEmail = "rohanbiradar2342001@gmail.com";
const base64data = Buffer.from('Dummy PDF Content').toString('base64');

fetch('http://localhost:3000/api/send-email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    to: targetEmail,
    bizName: "Test Business",
    pdfBase64: base64data,
    pdfName: `AI_Audit_Test.pdf`
  })
}).then(res => res.json()).then(console.log).catch(console.error);
