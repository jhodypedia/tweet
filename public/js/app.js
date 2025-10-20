// ===============================
// ✨ PansaGroup Dashboard Logic
// ===============================

// Simple appear-on-scroll animation
(() => {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) e.target.classList.add('show');
    });
  }, { threshold: .15 });
  document.querySelectorAll('[data-animate]').forEach(el => io.observe(el));
})();

$(function () {
  // =========================================================
  // 🧭 Variables
  // =========================================================
  let currentJobId = null;
  let pollTimer = null;
  let dt = null;
  let nextToken = null;
  let loadedTweets = 0;

  const elLoaded = $('#stat-loaded');
  const elHasMore = $('#stat-has-more');
  const btnLoadMore = $('#btn-load-more');
  const btnRefresh = $('#btn-refresh');
  const tableContainer = $('#tweetsTable').closest('.table-responsive');

  // =========================================================
  // 🧊 Utility
  // =========================================================
  const escapeHtml = s => String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));

  const fmtDate = iso => iso ? new Date(iso).toLocaleString() : "";

  const showLoadingOverlay = (text = "Memuat...") => {
    const overlay = `
      <div id="loading-overlay" class="position-absolute w-100 h-100 d-flex align-items-center justify-content-center"
           style="top:0; left:0; background:rgba(0,0,0,0.4); backdrop-filter:blur(4px); z-index:10;">
        <div class="text-center text-light">
          <div class="spinner-border text-info mb-3" role="status"></div>
          <div class="fw-semibold">${text}</div>
        </div>
      </div>`;
    tableContainer.css('position', 'relative').append(overlay);
  };
  const hideLoadingOverlay = () => $('#loading-overlay').remove();

  // =========================================================
  // 🪄 Delete All Tweets (Progress Modal)
  // =========================================================
  function openProgressModal(total) {
    Swal.fire({
      title: 'Menghapus tweet…',
      html: `
        <div class="text-start">
          <div class="mb-2">Total: <span id="swal-total">${total}</span></div>
          <div class="progress" role="progressbar">
            <div class="progress-bar progress-bar-striped progress-bar-animated" id="swal-bar" style="width:0%"></div>
          </div>
          <div class="d-flex justify-content-between mt-2 small">
            <div>Deleted: <span id="swal-deleted">0</span></div>
            <div><span id="swal-percent">0</span>%</div>
          </div>
          <div class="mt-2 small text-warning" id="swal-waiting"></div>
        </div>
      `,
      allowOutsideClick: false,
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: 'Tutup',
      didOpen: () => Swal.showLoading(),
      willClose: () => pollTimer && clearInterval(pollTimer)
    });
  }

  const updateBar = (deleted, total) => {
    const pct = total ? Math.floor((deleted / total) * 100) : 0;
    $('#swal-deleted').text(deleted);
    $('#swal-percent').text(pct);
    $('#swal-bar').css('width', pct + '%');
  };

  const beginPolling = () => {
    pollTimer = setInterval(async () => {
      if (!currentJobId) return;
      try {
        const st = await $.getJSON('/delete/status', { jobId: currentJobId });
        if (!st.ok) return;
        updateBar(st.deleted, st.total);

        if (st.status === 'waiting_limit') {
          $('#swal-bar').removeClass('bg-info').addClass('bg-warning');
          $('#swal-waiting').text('⏳ Rate limit — menunggu reset otomatis...');
          return;
        }
        $('#swal-waiting').text('');

        if (['done', 'error', 'canceled'].includes(st.status)) {
          clearInterval(pollTimer);
          currentJobId = null;
          Swal.close();
          const icon = st.status === 'done' ? 'success'
                     : st.status === 'error' ? 'error' : 'info';
          const title = st.status === 'done' ? 'Selesai'
                      : st.status === 'error' ? 'Gagal' : 'Dibatalkan';
          const html = st.status === 'error'
            ? `<pre class="text-start small">${escapeHtml(JSON.stringify(st.error, null, 2))}</pre>`
            : `<div class="text-start">Terhapus <b>${st.deleted}</b> dari <b>${st.total}</b> tweet.</div>`;
          Swal.fire({ icon, title, html, confirmButtonText: 'OK' });
        }
      } catch (err) { console.log('poll error', err); }
    }, 1500);
  };

  // Delete All
  $('#btnDeleteAll').on('click', async function () {
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
      if (!start.ok) throw new Error(start.error || 'Gagal memulai job');
      if (!start.jobId)
        return Swal.fire('Info', 'Akun ini tidak memiliki tweet untuk dihapus.', 'info');

      currentJobId = start.jobId;
      openProgressModal(start.total);
      beginPolling();
    } catch (err) {
      Swal.fire('Gagal', err.responseJSON?.error || err.statusText || 'Error', 'error');
    }
  });

  $('#btnCancel').on('click', async function () {
    if (!currentJobId) return;
    $(this).prop('disabled', true);
    try { await $.post('/delete/cancel', { jobId: currentJobId }); }
    catch (e) { console.warn('cancel failed', e); }
  });

  // =========================================================
  // 🧮 DataTables Tweet List
  // =========================================================
  const initDataTable = () => {
    if (dt) return dt;
    dt = $('#tweetsTable').DataTable({
      pageLength: 10,
      lengthMenu: [10, 25, 50],
      order: [[1, 'desc']],
      columnDefs: [
        { targets: [0], visible: true },
        { targets: [3, 4, 5, 6], className: 'text-end', width: '70px' },
        { targets: -1, orderable: false, searchable: false, width: '100px' }
      ],
      language: {
        emptyTable: "Tidak ada tweet untuk ditampilkan",
        info: "Menampilkan _START_–_END_ dari _TOTAL_ tweet",
        paginate: { previous: "‹", next: "›" }
      }
    });
    return dt;
  };

  async function loadTweets(cursor = "") {
    btnLoadMore.prop('disabled', true).text('Loading...');
    showLoadingOverlay("Mengambil data tweet...");
    try {
      const res = await $.getJSON('/tweets/list', { cursor, max: 100 });
      if (!res.ok) throw new Error(res.error || 'Gagal memuat tweet');

      const data = res.tweets || [];
      const table = initDataTable();
      const rows = data.map(t => {
        const m = t.public_metrics || {};
        return [
          t.id,
          fmtDate(t.created_at),
          `<div class='tweet-text'>${escapeHtml(t.text || '')}</div>`,
          m.like_count ?? 0,
          m.retweet_count ?? 0,
          m.reply_count ?? 0,
          m.quote_count ?? 0,
          `<button class="btn btn-sm btn-danger btn-delete" data-id="${t.id}" title="Hapus tweet ini">
             <i class="fa-solid fa-trash"></i>
           </button>`
        ];
      });
      table.rows.add(rows).draw(false);

      // Animasi baris baru fade-in
      $('#tweetsTable tbody tr').addClass('fadein');

      loadedTweets += rows.length;
      elLoaded.text(loadedTweets);
      nextToken = res.next_token || null;
      elHasMore.text(nextToken ? 'Yes' : 'No');
      btnLoadMore.toggle(!!nextToken);
    } catch (e) {
      Swal.fire('Error', e.message || 'Gagal memuat tweet', 'error');
    } finally {
      hideLoadingOverlay();
      btnLoadMore.prop('disabled', false).text('Load More');
    }
  }

  async function deleteTweet(id, btn) {
    const conf = await Swal.fire({
      title: 'Hapus tweet ini?',
      text: `Tweet ID: ${id}`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, hapus',
      cancelButtonText: 'Batal'
    });
    if (!conf.isConfirmed) return;

    try {
      btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
      const r = await $.post(`/tweets/${id}/delete`);
      if (!r.ok) throw new Error(r.error || 'Gagal menghapus tweet');
      const table = initDataTable();
      table.row(btn.closest('tr')).remove().draw(false);
      loadedTweets--;
      elLoaded.text(loadedTweets);
      Swal.fire('Berhasil', `Tweet ${id} telah dihapus.`, 'success');
    } catch (e) {
      Swal.fire('Gagal', e.message || 'Gagal menghapus tweet', 'error');
    } finally {
      btn.prop('disabled', false).html('<i class="fa-solid fa-trash"></i>');
    }
  }

  // =========================================================
  // Buttons & Events
  // =========================================================
  btnLoadMore.on('click', () => loadTweets(nextToken || ""));
  btnRefresh.on('click', () => {
    if (dt) dt.clear().draw();
    loadedTweets = 0;
    elLoaded.text('0');
    nextToken = null;
    elHasMore.text('-');
    loadTweets("");
  });

  $(document).on('click', '.btn-delete', function () {
    deleteTweet($(this).data('id'), $(this));
  });

  // Auto load
  if ($('#tweetsTable').length) loadTweets("");
});
