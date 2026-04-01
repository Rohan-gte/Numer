fetch('http://localhost:3000/api/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'rohanbiradar2342001@gmail.com', bizName: 'Test Biz' })
})
.then(r => r.json())
.then(console.log)
.catch(console.error);
