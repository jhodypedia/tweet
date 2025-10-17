// Simple appear-on-scroll animation (no external lib)
(function(){
  const io = new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(e.isIntersecting) e.target.classList.add('show');
    })
  }, { threshold:.15 });
  document.querySelectorAll('[data-animate]').forEach(el=>io.observe(el));
})();

$(function(){
  let currentJobId = null;
  let pollTimer = null;

  function openProgressModal(total){
    Swal.fire({
      title: 'Menghapus tweet…',
      html: `
        <div class="text-start">
          <div class="mb-2">Total: <span id="swal-total">${total}</span></div>
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar progress-bar-striped progress-bar-animated" id="swal-bar" style="width:0%"></div>
          </div>
          <div class="d-flex justify-content-between mt-2 small">
            <div>Deleted: <span id="swal-deleted">0</span></div>
            <div><span id="swal-percent">0</span>%</div>
          </div>
        </div>
      `,
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
      showCancelButton: true,
      cancelButtonText: 'Tutup'
    }).then(res=>{
      // if dialog closed while running, keep polling in background (optional).
    });
  }

  function updateBar(deleted, total){
    const pct = total ? Math.floor((deleted/total)*100) : 0;
    $('#swal-deleted').text(deleted);
    $('#swal-percent').text(pct);
    $('#swal-bar').css('width', pct + '%');
  }

  function beginPolling(){
    $('#btnCancel').prop('disabled', false);
    pollTimer = setInterval(async ()=>{
      try{
        const q = $.param({ jobId: currentJobId });
        const st = await $.getJSON('/delete/status?'+q);
        if (!st.ok) return;

        updateBar(st.deleted, st.total);

        if (st.status === 'done'){
          clearInterval(pollTimer); pollTimer=null; currentJobId=null;
          $('#btnCancel').prop('disabled', true);
          Swal.hideLoading();
          Swal.update({
            icon: 'success',
            title: 'Selesai',
            html: `<div class="text-start">Berhasil menghapus <b>${st.deleted}</b> dari <b>${st.total}</b> tweet.</div>`,
            showCancelButton: false,
            showConfirmButton: true
          });
        } else if (st.status === 'error'){
          clearInterval(pollTimer); pollTimer=null; currentJobId=null;
          $('#btnCancel').prop('disabled', true);
          Swal.hideLoading();
          Swal.update({
            icon: 'error',
            title: 'Gagal',
            html: `<pre class="text-start small">${escapeHtml(JSON.stringify(st.error, null, 2))}</pre>`,
            showCancelButton: false,
            showConfirmButton: true
          });
        } else if (st.status === 'canceled'){
          clearInterval(pollTimer); pollTimer=null; currentJobId=null;
          $('#btnCancel').prop('disabled', true);
          Swal.hideLoading();
          Swal.update({
            icon: 'info',
            title: 'Dibatalkan',
            html: `<div class="text-start">Proses dibatalkan. Terhapus <b>${st.deleted}</b> dari <b>${st.total}</b> tweet.</div>`,
            showCancelButton: false,
            showConfirmButton: true
          });
        }
      }catch(err){
        // network/other; biarkan polling lanjut
        console.log('poll error', err);
      }
    }, 800); // interval polling
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[m]));
  }

  $('#btnDeleteAll').on('click', async function(){
    const conf = await Swal.fire({
      title: 'Yakin hapus semua tweet?',
      text: 'Tindakan ini tidak bisa dibatalkan!',
      icon: 'warning',
      confirmButtonText: 'Ya, mulai hapus',
      showCancelButton: true,
      cancelButtonText: 'Batal'
    });
    if (!conf.isConfirmed) return;

    try{
      const start = await $.post('/delete/start');
      if (!start.ok){
        return Swal.fire({ icon:'error', title:'Gagal', text: start.error || 'Tidak bisa memulai job' });
      }
      if (!start.jobId){
        return Swal.fire({ icon:'info', title:'Tidak ada tweet', text:'Akun ini tidak memiliki tweet untuk dihapus.' });
      }
      currentJobId = start.jobId;
      openProgressModal(start.total);
      beginPolling();
    }catch(err){
      Swal.fire({ icon:'error', title:'Gagal', text: err.responseJSON?.error || err.statusText || 'Error' });
    }
  });

  $('#btnCancel').on('click', async function(){
    if (!currentJobId) return;
    $(this).prop('disabled', true);
    try{
      await $.post('/delete/cancel', { jobId: currentJobId });
    }catch(e){}
  });
});
