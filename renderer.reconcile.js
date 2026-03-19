(() => {
  if (typeof ipc === 'undefined') {
    var ipc = window.ipc ?? window.electron;
  }

  const containerId = 'reconcile-container';

  function render(discrepancies) {
    let container = document.getElementById(containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = containerId;
      container.style.position = 'fixed';
      container.style.top = '0';
      container.style.left = '0';
      container.style.right = '0';
      container.style.bottom = '0';
      container.style.background = 'rgba(0,0,0,0.8)';
      container.style.zIndex = '1000';
      container.style.overflow = 'auto';
      document.body.appendChild(container);
    } else {
      container.innerHTML = '';
    }

    const inner = document.createElement('div');
    inner.style.background = '#222';
    inner.style.margin = '40px auto';
    inner.style.padding = '20px';
    inner.style.maxWidth = '800px';
    inner.style.borderRadius = '8px';
    container.appendChild(inner);

    const actions = document.createElement('div');
    actions.className = 'reconcile-actions';
    actions.innerHTML = `
      <button id="reconcile-prefer-a">Prefer Engine A</button>
      <button id="reconcile-auto-accept">Auto-accept High Confidence</button>
      <button id="reconcile-submit">Submit</button>
    `;
    inner.appendChild(actions);

    const table = document.createElement('table');
    table.id = 'reconcile-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>#</th>
          <th>Engine A</th>
          <th>Engine B</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    inner.appendChild(table);

    const tbody = table.querySelector('tbody');

    discrepancies.forEach((d, idx) => {
      const row = document.createElement('tr');

      const tdIndex = document.createElement('td');
      tdIndex.textContent = String(idx + 1);
      row.appendChild(tdIndex);

      const buildChoiceCell = (choice, checkedDefault) => {
        const td = document.createElement('td');
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `word-${idx}`;
        input.value = choice;
        input.checked = !!checkedDefault;

        const word = choice === 'a' ? (d?.a?.word ?? '') : (d?.b?.word ?? '');
        const confVal = choice === 'a' ? (d?.a?.confidence ?? '') : (d?.b?.confidence ?? '');
        const conf = (confVal == null) ? '' : String(confVal);

        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${String(word)} (${conf})`));
        td.appendChild(label);
        return td;
      };

      row.appendChild(buildChoiceCell('a', true));
      row.appendChild(buildChoiceCell('b', false));
      tbody.appendChild(row);
    });

    inner.querySelector('#reconcile-prefer-a')?.addEventListener('click', () => {
      discrepancies.forEach((_d, idx) => {
        inner.querySelector(`input[name="word-${idx}"][value="a"]`).checked = true;
      });
    });

    inner.querySelector('#reconcile-auto-accept')?.addEventListener('click', () => {
      const threshold = 0.9;
      discrepancies.forEach((d, idx) => {
        const a = d.a.confidence ?? 0;
        const b = d.b.confidence ?? 0;
        if (a >= threshold && a >= b) {
          inner.querySelector(`input[name="word-${idx}"][value="a"]`).checked = true;
        } else if (b >= threshold && b > a) {
          inner.querySelector(`input[name="word-${idx}"][value="b"]`).checked = true;
        }
      });
    });

    inner.querySelector('#reconcile-submit')?.addEventListener('click', () => {
      const resolved = discrepancies.map((d, idx) => {
        const choice = inner.querySelector(`input[name="word-${idx}"]:checked`).value;
        return choice === 'a' ? d.a.word : d.b.word;
      });
      container.remove();
      window.dispatchEvent(new CustomEvent('reconcile-complete', { detail: resolved }));
    });
  }

  window.reconcileDiscrepancies = function (discrepancies) {
    render(discrepancies);
  };

  window.dispatchEvent(new Event('reconcile-ready'));
})();
