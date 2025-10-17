// Simple appear-on-scroll animation (no external lib)
(() => {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) e.target.classList.add('show');
    });
  }, { threshold: .15 });
  document.querySelectorAll('[data-animate]').forEach(el => io.observe(el));
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
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: 'Tutup',
      didOpen: () => {
        Swal.showLoading();
      },
      willClose: () => {
        // stop polling if modal manually closed
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }
    });
  }

  function updateBar(deleted, total){
    const pct = total ? Math.floor((deleted / total) * 100) : 0;
    $('#swal-deleted').text(deleted);
    $('#swal-percent').text(pct);
    $('#swal-bar').css('width', pct + '%');
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[m]));
  }

  function beginPolling(){
    pollTimer = setInterval(async ()=>{
      if (!currentJobId) return;
      try {
        const st = await $.getJSON('/delete/status', { jobId: currentJobId });
        if (!st.ok) return;

        updateBar(st.deleted, st.total);

        if (['done','error','canceled'].includes(st.status)) {
          clearInterval(pollTimer);
          pollTimer = null;
          currentJobId = null;

          // close old modal and show result
          Swal.close();
          const icon = st.status === 'done' ? 'success' :
                       st.status === 'error' ? 'error' : 'info';
          const title = st.status === 'done' ? 'Selesai' :
                        st.status === 'error' ? 'Gagal' : 'Dibatalkan';
          const html = st.status === 'error'
            ? `<pre class="text-start small">${escapeHtml(JSON.stringify(st.error, null, 2))}</pre>`
            : `<div class="text-start">Terhapus <b>${st.deleted}</b> dari <b>${st.total}</b> tweet.</div>`;

          Swal.fire({ icon, title, html, confirmButtonText: 'OK' });
        }
      } catch (err) {
        console.log('poll error', err);
      }
    }, 1500); // safer polling interval
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

    try {
      const start = await $.post('/delete/start');
      if (!start.ok) {
        return Swal.fire({ icon:'error', title:'Gagal', text: start.error || 'Tidak bisa memulai job' });
      }
      if (!start.jobId) {
        return Swal.fire({ icon:'info', title:'Tidak ada tweet', text:'Akun ini tidak memiliki tweet untuk dihapus.' });
      }
      currentJobId = start.jobId;
      openProgressModal(start.total);
      beginPolling();
    } catch (err) {
      Swal.fire({ icon:'error', title:'Gagal', text: err.responseJSON?.error || err.statusText || 'Error' });
    }
  });

  $('#btnCancel').on('click', async function(){
    if (!currentJobId) return;
    $(this).prop('disabled', true);
    try { await $.post('/delete/cancel', { jobId: currentJobId }); }
    catch(e){ console.warn('cancel failed', e); }
  });
});
