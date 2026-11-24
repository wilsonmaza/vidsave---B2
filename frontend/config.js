// Configuração do frontend — o único ficheiro que precisas de editar para
// apontar o site para o teu backend.
//
// API_BASE_URL
//   - Em produção: o endereço público (HTTPS) do backend, SEM barra no fim.
//     Ex.: 'https://vidsave-api.onrender.com'
//   - Em desenvolvimento (localhost / file://): pode ficar vazio — usa
//     automaticamente http://localhost:3000.
//   Se ficar vazio em produção, o site avisa que o servidor não está
//   configurado (em vez de tentar ligar a localhost, que nunca funciona a
//   partir da internet).
//
// ADS_SLOT_VISIBLE
//   Mostra o espaço reservado para publicidade (rodapé da página). Fica
//   false até existir um provider de anúncios aprovado.
window.VIDSAVE_CONFIG = {
  API_BASE_URL: '',
  ADS_SLOT_VISIBLE: false,
};
